# 后台服务

扩展的配套后台：存放并下发规则，接收扩展上报的页面抓取、操作录制与运行报告，并提供一个简单的管理页。消息格式见 [protocol.md](protocol.md)，规则格式见 [rules.md](rules.md)。代码在 `server/`。

## 技术与运行

- Python 3.12、FastAPI、Uvicorn，数据存 SQLite（单文件，数据目录挂卷）。
- 身份只信任反向代理（门卫）注入的请求头，应用本身不做登录：
  - `X-Portal-Sub`：稳定的用户标识；`X-Role`：只有 `admin` 算管理员，其余一律按 `user`。
  - 环境变量 `SZYYW_SSO` 不为 `1` 时，除 `/api/health` 外所有接口返回 503，绝不因为请求自带了头就放行。
  - 开了 SSO 但没有 `X-Portal-Sub` → 401。
  - 部署时容器不得对外发布端口，只能经反向代理访问，否则任何人都能伪造身份头。
- 配置（环境变量）：

| 变量              | 默认    | 说明                                                                                          |
| ----------------- | ------- | --------------------------------------------------------------------------------------------- |
| `SZYYW_SSO`       | 空      | 必须为 `1` 才信任身份头                                                                       |
| `DATA_DIR`        | `/data` | SQLite 与其他数据所在目录                                                                     |
| `RETENTION_DAYS`  | `90`    | 抓取、录制、运行报告的保留天数；每天与启动时清理                                              |
| `ALLOWED_ORIGINS` | 空      | 额外允许的 `Origin`（逗号分隔，用于管理页以外的来源）；默认只允许同源与 `chrome-extension://` |
| `PORT`            | `8000`  | 监听端口                                                                                      |

## 来源校验

状态修改类请求（POST / PUT / DELETE）与 WebSocket 握手检查 `Origin`：
- 没有 `Origin`（非浏览器客户端）、同源、`chrome-extension://…`、或在 `ALLOWED_ORIGINS` 里 → 放行；
- 其他网页来源 → 403（防止别的网站借用户的登录会话发请求）。

## 数据

- `users`：`sub`、`role`、`last_seen`、`seq`（该用户的下行序号计数器）。每次带有效身份头的请求都会登记或更新。
- `rules`：`id`（主键）、`owner_sub`、`shared`（0/1）、`version`、`body`（规则 JSON）、`updated_at`。
- `user_events`：`sub`、`seq`、`kind`（`ruleUpsert` / `ruleRemove`）、`payload`（JSON）、`created_at`；每用户保留最近 1000 条。
- `captures`、`recordings`、`run_reports`：扩展上报的原始消息（JSON）与摘要字段，属于上报者（`owner_sub`）。
- 上报内容大小上限 2 MB，超出返回 413。

## 规则可见性与序号

- 一条规则对 `owner_sub` 可见；`shared = 1`（仅管理员可设置）时对所有用户可见。
- 下行序号 `seq` **按用户**单调递增，保证扩展看到的序号连续（扩展发现缺口会请求全量）。
- 规则变化时写事件：
  - 新增或更新：给所有能看到它的用户各写一条 `ruleUpsert`（共享规则给所有已登记用户写）；
  - 删除，或共享改为私有：给不再能看到它的用户写 `ruleRemove`。
- 新用户（没有事件）连接时走全量；之后才登记的用户，共享规则只通过全量到达。
- 全量（`snapshot`）= 该用户当前可见的全部规则 + 该用户当前的 `seq`。
- 事件被裁剪后，`lastSeq` 小于最早保留序号减一的客户端会收到全量。

## 扩展接口（均需要身份头）

| 接口                              | 说明                                             |
| --------------------------------- | ------------------------------------------------ |
| `GET /api/me`                     | 返回 `{ "sub": "…", "role": "admin" \| "user" }` |
| `GET /api/health`                 | 公开，返回 `{ "ok": true }`                      |
| `WS /api/ext/ws`                  | 实时通道，见下                                   |
| `GET /api/ext/stream?since=<seq>` | SSE，见下                                        |
| `GET /api/ext/poll?since=<seq>`   | 返回 `{ "messages": [...] }`                     |
| `POST /api/ext/uplink`            | 接收一条上行消息（JSON 请求体）                  |

所有消息带信封 `v`（当前为 1）与 `id`。上行消息的 `v` 不是 1 时回复 `error`（`code: "UNSUPPORTED_VERSION"`）。下行消息的 `id` 由后台生成（UUID）。

### 会话建立（WebSocket / SSE）

1. 扩展发 `hello`（WebSocket 在连接后发；SSE 通过 `POST /api/ext/uplink` 发，同时 `stream?since=` 带本地序号）。
2. 后台按 `lastSeq`（或 `since`）决定：
   - 等于当前序号 → 什么都不发；
   - 在保留范围内且小于当前序号 → 依次补发其后的事件（`ruleUpsert` / `ruleRemove`，带各自 `seq`）；
   - 为空、大于当前序号或已被裁剪 → 发一条 `snapshot`。
3. 之后有新事件就实时推送。
4. `resync` → 立即发 `snapshot`（WebSocket 直接回；SSE 与轮询的客户端通过上行 POST 触发：SSE 推到流里，轮询在下一次轮询时返回）。
5. `ack`：记录该用户已确认的最大序号（仅用于运维查看，不影响重发）。

### WebSocket

- 握手检查身份头与 `Origin`；失败时以关闭码 4401（未登录）、4403（无权/来源不允许）关闭。
- 后台每 20 秒发一次 `ping`，扩展回 `pong`；扩展发来的 `ping` 回 `pong`。45 秒没有任何收到的消息就关闭连接。
- 无法解析的消息忽略并记日志，不断开。

### SSE

- `Content-Type: text/event-stream`，每条下行消息一个 `data: <json>` 事件；每 20 秒发一次注释行 `: keepalive`。

### 轮询

- `since` 缺省视为无本地序号。若 `since` 等于当前序号返回空数组；在保留范围内返回其后的事件；否则返回一条 `snapshot`。若该用户有未消费的 `resync` 请求，也返回 `snapshot`。

### 上行消息的处理

| kind            | 处理                                                               |
| --------------- | ------------------------------------------------------------------ |
| `hello`         | 登记客户端（`clientId`、`extVersion`），按上文补发或发全量         |
| `ack`           | 记录                                                               |
| `resync`        | 发全量                                                             |
| `ping` / `pong` | 回 `pong` / 忽略                                                   |
| `capture`       | 存入 `captures`，返回 202                                          |
| `recording`     | 存入 `recordings`；同一个 `recordingId` 重复上报视为已收到（幂等） |
| `runReport`     | 存入 `run_reports`；同一个 `runId` 幂等                            |

上行消息按 `id` 去重（扩展重连后会重发队列里的消息）。

### 实现细节补充

- 本地序号为 0，或该用户还没有任何事件时，一律发 `snapshot`（扩展初始的 `lastSeq` 就是 0；按“等于当前序号就不发”会让后登记的用户漏掉登记前已有的共享规则）。
- 经 HTTP 发来的 `hello` 只登记客户端，不再补发（补发由 `stream?since=` 完成）；HTTP 的 `resync` 既推到该用户的 SSE 流，也给轮询置位。
- `uplink` 响应：成功返回 `{ ok, messages, duplicate? }`，`capture` / `recording` / `runReport` 为 202，其余 200；出错时响应体就是一条 `error` 消息：格式错误 400（`INVALID_MESSAGE`）、超大 413（`PAYLOAD_TOO_LARGE`）。扩展对这类 4xx（除 401、403、408、429）会丢弃该条消息，不再重发。
- WebSocket：`SZYYW_SSO` 未开时以关闭码 1013 关闭；单条消息超过 2 MB 回 `error`，不断开。
- 数据库另有 `clients`、`uplink_seen`（上行去重，随保留期清理）、`ai_notes`（AI 解读缓存，见下文）三张表，`users` 多了 `acked_seq`、`resync_pending` 两列。
- 管理页的静态文件挂在根路径（如 `/app.js`），同样需要身份头。

## 管理接口（需要身份头，JSON）

普通用户只能管理自己的数据；管理员可以管理全部。

| 接口                                                                             | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/rules`                                                                 | 当前用户可见的规则：`[{ rule, ownerSub, shared, updatedAt }]`；管理员加 `?all=1` 看全部                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PUT /api/rules/{id}`                                                            | 请求体 `{ "rule": {…}, "shared"?: boolean }`；先校验规则（见下），`version` 必须大于已有版本，否则 409；`shared` 只有管理员能设为 true；写入并产生事件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DELETE /api/rules/{id}`                                                         | 删除，产生 `ruleRemove`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/rules/validate`                                                       | 请求体 `{ "rule": {…} }`，返回 `{ "ok": boolean, "errors": string[] }`，不保存                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/recordings`、`GET /api/recordings/{id}`、`DELETE /api/recordings/{id}` | 录制列表（摘要：`recordingId`、`startedAt`、步骤数、上报时间、所有者）、详情（含步骤）、删除                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /api/recordings/{id}/rule`                                                 | 把录制固化为规则。请求体只有 `name` 必填，其余 `{ id?, urls?, exclude?, trigger?, inputMode?, shared?, captchaLength? }` 都可省略：`id` 缺省时由名称生成（英文数字取成短标识，否则用 `rule`，加随机后缀保证不重复）；`urls` 缺省时从录制里的页面地址推断（用到的每个主机一条 `scheme://host/*`，最多 5 条，推断不出来返回 422）；`trigger` 缺省 `manual`，`inputMode` 缺省 `auto`。步骤取自录制，`requires` 由步骤中的占位符推出，`version` 为 1（或已有同 id 规则的版本 + 1）；校验通过后保存并返回规则。录制里“用 `{{secret.x}}` 填写验证码 / 短信验证码输入框”的步骤（`x` 含 captcha、verif、otp、sms、验证码等字样）会改成 `handoff` 步骤（提示“请在页面上输入验证码，完成后点「继续」”，`resumeWhen: userConfirm`），因为验证码每次都不同，保险库里存不了；改完后它们不再出现在 `requires` 里。录制里“用 `{{secret.x}}` 填写验证码 / 短信验证码输入框”的步骤（`x` 含 captcha、verif、otp、sms、验证码等字样）会改成 `handoff`（`resumeWhen: condition`，`until` 是该输入框的 `filled: true`（输入框填满，即达到 `maxlength`；请求体带 `captchaLength`（1 到 20 的整数）时改用 `minLength`），输完自动继续，侧边栏的「继续」仍可手动继续）：验证码每次都不同，保险库里存不了；改完后它们不再出现在 `requires` 里 |
| `GET /api/captures`、`GET /api/captures/{id}`、`DELETE /api/captures/{id}`       | 抓取：列表（页面 URL、标题、元素数、时间）、详情、删除                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/runs`、`GET /api/runs/{runId}`                                         | 运行报告：列表（可用 `?ruleId=` 过滤，按时间倒序，默认 100 条）、详情                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

录制、抓取、运行报告的列表，管理员默认看全部；规则仍按上面的 `?all=1`。普通用户设 `shared=true` 返回 403；路径里的 id 与规则 id 不一致、或校验失败返回 422 `{ detail, errors }`；`DELETE` 返回 204。

列表接口支持 `?limit=`（默认 100，最大 500）。找不到或无权访问一律 404。

管理页 `GET /` 是一个静态页面（同样需要身份头），通过上面的接口查看规则、录制、抓取与运行报告，编辑规则 JSON，把录制生成规则。

## AI 解读

把录制或规则交给 Claude（经用户自己的 claude-bridge 服务），生成整体说明和每一步的中文描述（如“点击登录按钮”“输入验证码（交还给你）”），让规则不再是一串定位器。描述写进步骤的 `note`，扩展运行时显示在侧边栏。

**配置**：`CLAUDE_BRIDGE_URL` 与 `CLAUDE_BRIDGE_TOKEN` 都设置才可用，否则相关接口返回 503、管理页不显示 AI 按钮。后台通过 claude-bridge 的调用方接口提交一次性任务（`POST {CLAUDE_BRIDGE_URL}/api/caller/tasks`，带 `Authorization: Bearer <令牌>`），再长轮询 `GET /api/caller/tasks/{id}?wait=N` 取结果；整体超时 `AI_TIMEOUT_SEC` 秒（同时作为 bridge 侧任务的超时，到点自动取消）。bridge 侧需要：用 `claude-bridge callers add <名称> --user <账户> --scope <scope>` 建调用方令牌；多用户模式下把该 scope 加进 `CLAUDE_BRIDGE_SCOPES`；worker 的 `CLAUDE_BRIDGE_PROFILES` 给该 scope 一个没有任何工具的 profile。

**脱敏**（发送前一律处理，日志也不记录发送内容与回答）：
- 只发送步骤的 `id`、`type` 和下面这些字段，`note`、超时等其他字段都不发；
- 定位器只取可读的部分：`aria` 的角色与名称、`text` 的文字、`testid`、`css` 里的 `#id` 与 `[name="…"]`；不发 `xpath` 与长 css 路径；
- `open.url`、`waitFor` / `switchTab` 的 `urlPattern`、`url` 条件的 `pattern` 只保留网站与路径（去掉账号、查询串与 `#`）；
- `fill.value`：占位符（`{{profile.x}}`、`{{secret.x}}`、`{{var.x}}`）原样保留，其他字面值替换为 `<用户输入，N 个字符>`；
- `select.value`（页面上的选项值）、`check.checked`、`press.key`、`handoff.message`、`extract.saveAs` 保留；
- `if` / `repeat` 的条件按上面的规则处理，`then` / `else` / `steps` 递归处理。

**接口**（权限与其他管理接口一致：只能操作自己的，管理员可操作全部，否则 404）：

| 接口                                 | 说明                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/ai/status`                 | `{ available, model }`：AI 是否可用、使用的模型（不可用时 `model` 为 `null`）                                                                                                                                                                                                                               |
| `POST /api/recordings/{id}/describe` | 生成录制的解读：`{ summary, steps: [{ id, text }], model, createdAt, cached }`；有缓存时直接返回（`cached: true`），`?refresh=1` 强制重新生成；录制没有步骤返回 422                                                                                                                                         |
| `GET /api/recordings/{id}`           | 已有解读缓存时，详情多一个 `ai` 字段（同上，不含 `cached`）                                                                                                                                                                                                                                                 |
| `POST /api/recordings/{id}/rule`     | 已有解读缓存时，把每步的描述写进生成规则对应步骤的 `note`（录制里已有的 note 不覆盖）；没有缓存不调用 AI                                                                                                                                                                                                    |
| `POST /api/rules/{id}/describe`      | 对当前规则（含 `login.steps` 与嵌套步骤）生成描述，只填空的 `note`，`version + 1` 保存为新版本并推送给扩展；返回 `{ rule, summary, added, model, cached }`（`added` 是写入的条数；为 0 时不产生新版本）。共享规则只有管理员能做（所有者是普通用户时 403）；AI 调用期间规则被改过返回 409；`?refresh=1` 同上 |

`steps` 按步骤顺序每个 id 一条；模型没给出或给错的步骤用按类型生成的泛化描述补齐（如“点击按钮”“填写输入框”“交还给你处理”），这些兜底描述不会写进 `note`。描述最长 40 字。

**错误码**：AI 未配置 503 `{ "detail": "AI 未配置" }`；超时 504 `{ "detail": "AI 响应超时" }`；连不上 bridge、bridge 返回错误（worker 不在线、并发已满、配额不足、令牌无效等）或回答无法解析 502 `{ "detail": "AI 解读失败" }`。

**缓存**：表 `ai_notes(kind, ref, owner_sub, digest, body, model, created_at)`，主键 `(kind, ref)`，`kind` 为 `recording` / `rule`。`digest` 是脱敏后输入的 SHA-256，输入变了（例如规则步骤改了）缓存自动失效；note 不参与摘要，所以填完 note 再解读会命中缓存。录制被删除或过了保留期、规则被删除时，对应的缓存一并删除。

## 规则校验

后台保存规则前，用与扩展相同的约束校验（扩展接收时还会再校验一次）：
- 必填：`id`、`name`、`version`（非负整数）、`match.urls`（至少一条）、`steps`（至少一步）。
- `match.urls` 不允许匹配全部网站（`<all_urls>`、`*`、主机部分为单独 `*` 的写法）。
- 步骤 `id` 在规则内唯一（含 `login.steps` 与嵌套步骤）；`type` 必须是已知类型；`if` / `repeat` 嵌套最多 3 层。
- `{{secret.x}}` 只能出现在 `fill` 步骤的 `value` 中；`requires.profile` / `requires.secret` 必须覆盖规则里出现的全部 `{{profile.x}}` / `{{secret.x}}`。
- `waitFor`：`until = condition` 需要 `condition`，`until = delay` 需要 `delayMs`；`handoff`：`resumeWhen = condition` 需要 `until`。

## 安全要点

- 只信任门卫注入的身份头；容器不发布端口。
- 部署验证必须包含“伪造身份头加任意 `Authorization` 头，结果不得为 200”的测试。
- `Origin` 校验，防止其他网站借登录会话发请求。
- 上报内容有大小上限，数据有保留期；管理页输出一律转义。
- 日志不记录上报的页面文本与表单值。
