# 消息协议

扩展与后台之间的消息使用 JSON，由 `src/schema` 中的 Zod 定义校验。架构与安全约束见 [architecture.md](architecture.md)。

## 认证

扩展沿用门户的网页会话 cookie，不使用令牌，也不保存密码。
- 登录：`POST <门户>/api/login`，JSON `{ "username", "password" }`，请求带 `credentials: 'include'`。成功时门户通过 `Set-Cookie` 下发会话 cookie，响应 `{ "ok": true, "id", "user", "role" }`。错误：`401` / `invalid_credentials` 账号或密码错误，`account_expired` 账号已过期，`429` 请求过于频繁。
- 登出：`POST <门户>/api/logout`。
- 当前用户：`GET <后台>/api/me`，响应 `{ "sub", "role"? }`，`sub` 作为用户标识。
- 之后对后台的所有请求（WebSocket 握手、SSE、轮询、上报、`/api/me`）都不带 `Authorization` 头，靠浏览器自动带上的会话 cookie，由后台前面的门卫识别身份。
- WebSocket 地址 `wss://<后台>/api/ext/ws`，握手带 cookie，无需票据。**注意**：浏览器只在 cookie 为 `SameSite=None; Secure` 时才会在 WebSocket 握手里带上它；门户会话 cookie 若是 `Lax`，握手会被拒，扩展会自动回退到 SSE，同步照常工作，只是每次重连多一次失败尝试，此时可在设置页直接把通道选为 SSE。SSE `GET /api/ext/stream?since=`、轮询 `GET /api/ext/poll?since=`、上行 `POST /api/ext/uplink` 同样靠 cookie。
- 后台返回 `401` 或重定向到登录页 → 扩展变为未登录，需要重新登录。
- 关闭码 `4401` → 会话失效，同上。
- 后台返回 `403` 或关闭码 `4403` → 账号无权使用扩展，扩展停止重连。

## 通道

按设置选择首选通道，不可用时依次回退：WebSocket → SSE → 轮询。

| 通道      | 下行                                                                                                                                                | 上行                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| WebSocket | 同一连接                                                                                                                                            | 同一连接               |
| SSE       | `GET /api/ext/stream?since=<seq>`，用 `fetch` 读取流（service worker 中没有 `EventSource`），每条 `data:` 是一条下行消息                            | `POST /api/ext/uplink` |
| 轮询      | `GET /api/ext/poll?since=<seq>`，响应 `{ "messages": [下行消息…] }`，由 `chrome.alarms` 触发，间隔 ≥ 30 秒；不发送 `hello`，以 `since` 表示本地序号 | `POST /api/ext/uplink` |
- 心跳：WebSocket 上扩展每 20 秒发送 `ping`、后台也周期性发送 `ping`，对方回复 `pong`；，既检测断线，也让 service worker 保持活跃；SSE 由后台每 20 秒发送注释行。
- 重连：指数退避（1 秒起，翻倍，上限 60 秒，带随机抖动）。
- 上行消息在发送失败时进入本地队列（`storage.local`，上限 500 条），恢复连接后按顺序重发。

## 消息信封

所有消息共享以下字段：

| 字段   | 说明                                                    |
| ------ | ------------------------------------------------------- |
| `v`    | 协议版本，当前为 `1`。主版本不兼容时后台以 `error` 回复 |
| `kind` | 消息类型                                                |
| `id`   | 消息 ID（UUID），用于去重与确认                         |
| `seq`  | 仅下行：后台为每个用户维护的单调递增序号                |

## 会话建立

1. 连接建立后扩展发送 `hello`：

   ```json
   {
     "v": 1, "kind": "hello", "id": "…",
     "clientId": "扩展安装时生成的 UUID",
     "extVersion": "0.1.0",
     "ruleSchemaVersion": 1,
     "lastSeq": 42
   }
   ```

2. 后台根据 `lastSeq` 决定：
   - 能补齐增量：依次推送 `lastSeq` 之后的 `ruleUpsert` / `ruleRemove`；
   - 不能补齐或 `lastSeq` 为空：推送一次 `snapshot`。
3. 扩展收到下行消息后按 `seq` 顺序应用；发现序号缺口时发送 `resync`，后台回复 `snapshot`。

## 上行（扩展 → 后台）

| kind        | 说明                                                                    |
| ----------- | ----------------------------------------------------------------------- |
| `hello`     | 会话建立，见上文                                                        |
| `ack`       | 确认已应用的下行消息：`{ "seq": 43 }`，确认后该序号及之前的消息不再重发 |
| `resync`    | 请求全量 `snapshot`                                                     |
| `capture`   | 页面元素信息，见下文                                                    |
| `recording` | 一次录制得到的步骤序列，凭据类输入已替换为占位符                        |
| `runReport` | 规则执行结果，见下文                                                    |
| `ping`      | 心跳（WebSocket）                                                       |
| `pong`      | 心跳回复                                                                |

### capture

```json
{
  "kind": "capture",
  "pageUrl": "https://example.com/form",
  "title": "…",
  "capturedAt": 1760000000000,
  "elements": [
    {
      "tag": "input",
      "role": "textbox",
      "name": "用户名",
      "attrs": { "type": "text", "name": "user" },
      "locator": { "strategies": [{ "kind": "css", "value": "#user" }] },
      "sensitive": false
    }
  ]
}
```

- `sensitive: true` 的元素不带 `text`，`attrs` 中不含 `value` 等取值类属性。
- 不采集 `data-*` 中形似令牌的长随机串。

### runReport

```json
{
  "kind": "runReport",
  "runId": "…",
  "ruleId": "booking",
  "ruleVersion": 3,
  "trigger": "manual",
  "startedAt": 1760000000000,
  "endedAt": 1760000060000,
  "status": "succeeded",
  "inputMode": "trusted",
  "steps": [
    { "stepId": "s1", "status": "succeeded", "attempts": 1, "durationMs": 820 },
    {
      "stepId": "s2",
      "status": "failed",
      "attempts": 3,
      "durationMs": 45000,
      "errorCode": "TARGET_NOT_FOUND"
    }
  ]
}
```

- `status`：`succeeded` / `failed` / `aborted`（用户中止）/ `handedOff`（以 `final` 交还结束）。
- 步骤 `status`：`succeeded` / `failed` / `skipped` / `handedOff`（`handoff` 步骤，或步骤失败暂停后由用户手动处理、被用户越过的步骤）。同一步骤重试或被跳回重新执行时，可能出现多条记录。
- 错误码：`TARGET_NOT_FOUND`、`TIMEOUT`、`ASSERT_FAILED`、`NAVIGATION_FAILED`、`PERMISSION_DENIED`、`DATA_MISSING`、`SECRET_ORIGIN_DENIED`、`REPEAT_EXHAUSTED`、`USER_ABORTED`、`INTERNAL`。
- 不包含页面文本、表单值、`extract` 结果或占位符解析结果。

## 下行（后台 → 扩展）

| kind         | 说明                                                          |
| ------------ | ------------------------------------------------------------- |
| `snapshot`   | 当前用户可见的全量规则，扩展以此替换本地缓存                  |
| `ruleUpsert` | 新增或更新一条规则；`version` 不大于本地版本时忽略            |
| `ruleRemove` | 删除一条规则，正在运行的该规则会被中止                        |
| `ping`       | 心跳，扩展回复 `pong`                                         |
| `pong`       | 对扩展 `ping` 的回复                                          |
| `error`      | 协议错误：`{ "code": "UNSUPPORTED_VERSION", "message": "…" }` |
- 扩展收到不符合 schema 的规则时丢弃该规则并在本地日志记录原因，不中断其他规则的同步。
- 规则中出现违反扩展安全约束的内容（如凭据占位符出现在非 `fill` 字段）时，同样拒收。

## 隐私约定

- 密码框、支付字段、验证码输入框不采集值。
- `profile` 与 `secret` 数据只存在本机，不出现在任何上行消息中。
- 用户在人工交还期间的操作不录制、不上报。
