# 消息协议

扩展与后台之间的消息使用 JSON，由 `src/schema` 中的 Zod 定义校验。架构与安全约束见 [architecture.md](architecture.md)。

## 认证

- 扩展通过门户 OAuth 2.0（授权码 + PKCE）登录，获得访问令牌与刷新令牌。授权服务地址默认与后台相同，可在设置页单独指定（`authUrl`）：
  - 授权：`GET <authUrl>/oauth/authorize`，参数 `response_type=code`、`client_id`、`redirect_uri`、`code_challenge`、`code_challenge_method=S256`、`state`；
  - 令牌：`POST <authUrl>/oauth/token`（表单），`grant_type` 为 `authorization_code`（带 `code`、`redirect_uri`、`code_verifier`）或 `refresh_token`（带 `refresh_token`）；
  - 响应：`{ "access_token", "refresh_token", "expires_in", "user_id" }`；未提供 `user_id` 时取访问令牌（JWT）的 `sub`。
- HTTP 请求（SSE、轮询、上报）携带请求头 `Authorization: Bearer <访问令牌>`。
- 浏览器的 WebSocket 无法设置请求头，因此先换取一次性连接票据：

```http
POST /api/ext/ws-ticket
Authorization: Bearer <访问令牌>

200 { "ticket": "…", "expiresIn": 30 }
```

再连接 `wss://<后台>/api/ext/ws?ticket=<ticket>`。票据只能使用一次，有效期 30 秒。
- 后台返回 `401` 或以关闭码 `4401` 断开时，扩展刷新令牌后重连；刷新失败则提示用户重新登录。
- 后台返回 `403` 或关闭码 `4403` 表示账号无权使用扩展，扩展停止重连。

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
- 步骤 `status`：`succeeded` / `failed` / `skipped` / `handedOff`。
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
