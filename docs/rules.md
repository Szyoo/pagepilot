# 规则格式

规则是一份 JSON，描述「在哪些页面、按什么步骤」自动执行。定义见 `src/schema/rule.ts`，安全约束见 [architecture.md](architecture.md#安全约束)。

配置了 AI 时，可以在后台管理页的规则详情里用自然语言修改规则（「AI 修改」），看过前后对比再保存为新版本，见 [backend.md](backend.md#ai-修改)。

## 顶层结构

| 字段        | 类型 / 默认值                                           | 说明                                                           |
| ----------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| `id`        | string                                                  | 规则 ID，全局唯一                                              |
| `name`      | string                                                  | 显示名称                                                       |
| `version`   | 非负整数                                                | 单调递增；扩展只接受比本地更大的版本                           |
| `enabled`   | boolean，默认 `true`                                    | 后台侧开关                                                     |
| `trigger`   | `"manual"` \| `"auto"`，默认 `"manual"`                 | `auto` 表示打开匹配页面时自动运行，需用户在扩展中逐条开启      |
| `inputMode` | `"auto"` \| `"trusted"` \| `"synthetic"`，默认 `"auto"` | 输入方式，见 [architecture.md](architecture.md#输入方式)       |
| `match`     | object                                                  | `urls`：URL glob 列表（至少一条）；`exclude`：排除的 glob 列表 |
| `requires`  | object                                                  | `profile`、`secret`：规则用到的本地数据键名                    |
| `login`     | object，可选                                            | 登录状态判断与登录流程，见下文                                 |
| `steps`     | Step[]，至少一步                                        | 主流程                                                         |
- `match.urls` 不允许 `<all_urls>`、`*://*/*` 这类匹配全部网站的写法。
- `requires` 必须覆盖规则中出现的全部 `{{profile.x}}` 与 `{{secret.x}}`，否则拒收。

## 登录状态

```json
"login": {
  "loggedIn": { "kind": "element", "target": { "strategies": [{ "kind": "testid", "value": "user-menu" }] } },
  "steps": [
    { "id": "l1", "type": "open", "url": "https://example.com/login" },
    { "id": "l2", "type": "fill", "target": { "strategies": [{ "kind": "css", "value": "#user" }] }, "value": "{{secret.user}}" },
    { "id": "l3", "type": "fill", "target": { "strategies": [{ "kind": "css", "value": "#pass" }] }, "value": "{{secret.pass}}" },
    { "id": "l4", "type": "handoff", "message": "请完成验证并登录", "resumeWhen": "condition",
      "until": { "kind": "element", "target": { "strategies": [{ "kind": "testid", "value": "user-menu" }] } } }
  ]
}
```

- 运行开始时先判断 `loggedIn`；成立则跳过 `login.steps`，否则执行完 `login.steps` 再进入主流程。
- 主流程中途检测到登录失效（`loggedIn` 不成立且页面跳到登录页）时，执行一次 `login.steps` 后从当前步骤继续；同一次运行最多重新登录 2 次。
- 建议登录的提交动作交给用户（如上例 `l4`），以应对人机验证。

## 定位器

```json
{
  "strategies": [
    { "kind": "testid", "value": "submit" },
    { "kind": "aria", "value": "button[name=\"提交\"]" },
    { "kind": "css", "value": "form .btn-primary" }
  ],
  "frame": ["iframe#booking"]
}
```

- `kind`：`css` / `aria` / `text` / `xpath` / `testid`，按顺序尝试，第一个唯一命中的生效。
- 命中多个元素时视为未命中，继续尝试下一条策略。
- `frame`：目标位于 iframe 时，从顶层到目标 frame 的选择器链。

## 条件

`waitFor`、`assert`、`if`、`repeat`、`handoff` 共用以下条件定义：

| kind      | 字段                                                                                | 成立条件                                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `element` | `target`；可选 `visible`（默认 `true`）、`text`、`textMatch`、`filled`、`minLength` | 元素存在（且可见）；给出 `text` 时文本包含该值，`textMatch` 为正则；`filled: true` 时目标须是输入框且已填满（有 `maxlength` 时长度达到它，否则非空）；`minLength` 时目标须是输入框且内容至少这么多字符（验证码实际位数与 `maxlength` 不一致时用） |
| `url`     | `pattern`（glob）                                                                   | 当前页面 URL 匹配                                                                                                                                                                                                                                 |
| `not`     | `condition`                                                                         | 子条件不成立                                                                                                                                                                                                                                      |
| `all`     | `conditions`                                                                        | 全部成立                                                                                                                                                                                                                                          |
| `any`     | `conditions`                                                                        | 任一成立                                                                                                                                                                                                                                          |

## 步骤

所有步骤共有字段：

| 字段        | 默认值  | 说明                                                                                 |
| ----------- | ------- | ------------------------------------------------------------------------------------ |
| `id`        | 必填    | 规则内唯一（含嵌套步骤）                                                             |
| `note`      | —       | 步骤说明；运行时显示在侧边栏的运行卡片上（“正在：…”），后台的 AI 解读会填写空的 note |
| `timeoutMs` | `15000` | 单次尝试的超时                                                                       |
| `retries`   | `0`     | 失败后的重试次数                                                                     |
| `optional`  | `false` | 失败时跳过而不是中断整条规则                                                         |

### 页面操作

| type        | 字段                                                     | 说明                                                                                                                           |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `open`      | `url`、`newTab`（默认 `false`）、`force`（默认 `false`） | 打开页面；标签页已经停在同一页面（网站与路径相同、已加载完，忽略查询参数与锚点）时直接进入下一步，`force: true` 时总是重新打开 |
| `click`     | `target`                                                 | 点击                                                                                                                           |
| `fill`      | `target`、`value`、`clear`（默认 `true`）                | 输入文本；唯一允许使用 `{{secret.x}}` 的位置                                                                                   |
| `select`    | `target`、`value`                                        | 选择下拉项（按值或显示文本）                                                                                                   |
| `check`     | `target`、`checked`                                      | 勾选 / 取消勾选                                                                                                                |
| `press`     | `key`、可选 `target`                                     | 按键，如 `Enter`、`Control+A`                                                                                                  |
| `switchTab` | `urlPattern`                                             | 切换到 URL 匹配的已有标签页                                                                                                    |
| `extract`   | `target`、`saveAs`、`attr`（默认取文本）                 | 读取值保存为 `{{var.<saveAs>}}`，只在本次运行内有效                                                                            |

### 等待与判断

| type      | 字段                                                                          | 说明                       |
| --------- | ----------------------------------------------------------------------------- | -------------------------- |
| `waitFor` | `until`：`condition` / `navigation` / `newTab` / `idle` / `delay`，及对应字段 | 等待到指定状态，超时即失败 |
| `assert`  | `condition`                                                                   | 条件不成立即失败           |
| `if`      | `condition`、`then`、可选 `else`                                              | 按条件执行其中一组步骤     |

`waitFor` 的字段要求：

| until        | 必填字段          |
| ------------ | ----------------- |
| `condition`  | `condition`       |
| `navigation` | 可选 `urlPattern` |
| `newTab`     | 可选 `urlPattern` |
| `idle`       | —                 |
| `delay`      | `delayMs`         |

### 反复执行

`repeat` 反复执行一组步骤，直到条件成立，适用于刷新等待名额、轮询状态等场景：

| 字段            | 默认值   | 说明                                                  |
| --------------- | -------- | ----------------------------------------------------- |
| `steps`         | 必填     | 每轮执行的步骤                                        |
| `until`         | 必填     | 每轮结束后判断，成立即退出循环                        |
| `reload`        | `false`  | 从第 2 轮起，每轮开始前刷新当前页面                   |
| `intervalMs`    | `5000`   | 两轮之间的间隔，不低于扩展设定的下限（默认 3000）     |
| `jitterMs`      | `0`      | 在间隔上叠加 0 ~ `jitterMs` 的随机值                  |
| `maxAttempts`   | `100`    | 最多执行轮数                                          |
| `maxDurationMs` | —        | 最长持续时间                                          |
| `onExhausted`   | `"fail"` | 达到上限仍未成立时：`fail` 失败，`handoff` 交还给用户 |
| `notify`        | `true`   | 条件成立时发送系统通知                                |
| `sound`         | `false`  | 条件成立时播放提示音；同时受扩展设置中的声音开关控制  |
- 每轮内某一步失败时，本轮结束并进入下一轮，不中断整个循环。
- `repeat` 的 `timeoutMs` 不生效，由 `maxAttempts` 与 `maxDurationMs` 控制。

### 人工交还

| 字段         | 默认值          | 说明                                                                    |
| ------------ | --------------- | ----------------------------------------------------------------------- |
| `message`    | 必填            | 显示给用户的提示                                                        |
| `resumeWhen` | `"userConfirm"` | `userConfirm` 用户点击继续；`navigation` 页面跳转；`condition` 条件成立 |
| `until`      | —               | `resumeWhen` 为 `condition` 时必填                                      |
| `final`      | `false`         | 为 `true` 时到此结束，把控制权完全交还用户                              |
- 交还步骤的 `timeoutMs` 默认不限时；用户可随时中止。
- 交还期间侧边栏总是有「继续」按钮：`resumeWhen` 为 `navigation` / `condition` 时会在条件满足后自动继续，条件迟迟不满足也可以手动继续。用户处理完交还后 30 秒内，不会因页面上仍有验证码而再自动交还一次。
- 验证码输入：录制时验证码、短信验证码这类输入框（名称含 captcha、verif、otp、sms 等）会直接录成 `handoff`（`resumeWhen: condition`，`until` 是该输入框的 `minLength: <录制时输入的位数>`，录制时没输入则用 `filled: true`）：用户在页面上输完验证码就自动继续。
- 识别验证码类输入看的是输入框的名称、id、`aria-label`、标题、占位文字和关联的 label，常见字样包括 captcha、verif、otp、sms code、auth code、验证码、認証、인증、보안문자；单独的 “sms”（多半是接短信的手机号）和单独的 `autocomplete="one-time-code"` 标记不算。录了字面值的验证码（如短信验证码）在生成规则时同样改成交还，位数取录制时输入的长度。
- 回放期间检测到人机验证组件时，会自动插入一次交还（`resumeWhen: condition`，条件为验证组件消失），无需在规则中显式编写。
- 规则里只要写了交还步骤（含登录步骤与嵌套步骤），就视为作者已安排好在哪一步亲自处理验证码，**不再做自动检测**，避免在页面一打开就显示验证码的网站上提前暂停（例如在填好个人信息之前）。

#### 步骤失败时暂停

页面操作、等待、判断等叶子步骤重试用尽仍失败时，运行不会直接结束，而是暂停交给用户（侧边栏显示“等你处理”，并发送不带提示音的系统通知），用户可以在页面上手动处理后再继续。
- 不暂停的情况：步骤标了 `optional`（照常记为跳过）；运行被中止（`USER_ABORTED`）；失败发生在 `repeat` 的循环体里（照常进入下一轮）；重新登录时执行的登录步骤失败（照常按失败处理）。
- 判断继续的位置：失败后标签页没有发生过跳转时，建议重新执行失败的那一步；发生过跳转时，在失败步骤及其后面的同级步骤里从后往前找“到达某页”的步骤——`open`（按网址的 origin + 路径做前缀比较，含占位符的跳过）、带 `urlPattern` 的 `waitFor`（`navigation` / `newTab`）、`switchTab`——网址与当前页面匹配时，建议从它的下一步继续；都不匹配时仍建议失败的那一步。暂停期间每秒重新判断一次，侧边栏实时更新。
- 用户的四种选择：
  - **继续**：从建议的那一步继续（建议的位置越过这一层最后一步时，表示这一层已完成，接着执行外层后面的步骤）；
  - **重试这一步**：重新执行失败的那一步；
  - **跳过这一步**：从失败步骤的下一步继续；
  - **改从哪一步开始**：在失败步骤所在那一层的步骤里任选一步继续（嵌套的 `if` / `repeat` 作为一个整体）。
- 继续前会重新读取本地数据，用户可以先去设置页补上缺少的数据。暂停期间随时可以中止。
- 运行报告里的记录：继续到更后面的步骤时，失败的那一步与被用户越过的步骤记为 `handedOff`；跳过时失败的那一步记为 `skipped`；重试或回到更早的步骤时，已有记录不变，重新执行的步骤照常追加记录。
- 暂停期间 service worker 被回收时，恢复后会重新执行失败的那一步，再次失败则再次暂停。

### 嵌套限制

`if` 与 `repeat` 可以嵌套，最大深度 3 层。`login.steps` 中不能再包含 `login`。

## 占位符

文本字段中可使用以下占位符，全部在本机解析，不会上报：

| 占位符          | 来源                          | 允许出现的位置  |
| --------------- | ----------------------------- | --------------- |
| `{{profile.x}}` | 本地个人信息                  | 所有文本字段    |
| `{{secret.x}}`  | 本地凭据，绑定允许使用的域名  | 仅 `fill.value` |
| `{{var.x}}`     | 本次运行中 `extract` 保存的值 | 所有文本字段    |
- 解析失败（键不存在、凭据域名不符）时，该步骤失败，不会把占位符原文填入页面。
- 不支持表达式与过滤器；需要转义时写 `\{{`。

## 录制

录制结果以 `recording` 消息上报，步骤格式与规则相同，并做以下处理：
- 密码框、支付字段、验证码输入框、`autocomplete` 为凭据类的输入：值替换为 `{{secret.<字段名>}}`。
- 输入值与本地个人信息中某一项完全相同时，替换为对应的 `{{profile.x}}`。
- 其余输入值保留原文；上报前在 sidepanel 展示步骤列表，用户可以删除步骤或把输入值改为占位符。
- 跨标签页操作记录为 `open`（`newTab: true`）与 `switchTab`。
- 人工交还期间的操作不录制。

## 校验

扩展在接收规则时执行以下校验，任一不通过则拒收该规则：
- 符合 schema，步骤 `id` 在规则内唯一；
- `waitFor`、`handoff` 的字段组合符合上文要求；
- `{{secret.x}}` 只出现在 `fill.value`；
- `requires` 覆盖全部 `profile` 与 `secret` 占位符；
- `match.urls` 不匹配全部网站；
- 嵌套深度不超过 3。

## 示例

登录后反复刷新，直到出现可预约时段，再交给用户选择：

```json
{
  "id": "booking-demo",
  "name": "预约示例",
  "version": 1,
  "trigger": "manual",
  "inputMode": "trusted",
  "match": { "urls": ["https://example.com/*"] },
  "requires": { "profile": ["name", "phone"], "secret": ["user", "pass"] },
  "login": {
    "loggedIn": {
      "kind": "element",
      "target": { "strategies": [{ "kind": "testid", "value": "user-menu" }] }
    },
    "steps": [
      { "id": "l1", "type": "open", "url": "https://example.com/login" },
      {
        "id": "l2",
        "type": "fill",
        "target": { "strategies": [{ "kind": "css", "value": "#user" }] },
        "value": "{{secret.user}}"
      },
      {
        "id": "l3",
        "type": "fill",
        "target": { "strategies": [{ "kind": "css", "value": "#pass" }] },
        "value": "{{secret.pass}}"
      },
      {
        "id": "l4",
        "type": "handoff",
        "message": "请完成验证并点击登录",
        "resumeWhen": "condition",
        "until": {
          "kind": "element",
          "target": { "strategies": [{ "kind": "testid", "value": "user-menu" }] }
        }
      }
    ]
  },
  "steps": [
    { "id": "s1", "type": "open", "url": "https://example.com/booking" },
    {
      "id": "s2",
      "type": "repeat",
      "reload": true,
      "intervalMs": 8000,
      "jitterMs": 4000,
      "maxAttempts": 300,
      "onExhausted": "handoff",
      "steps": [{ "id": "s2a", "type": "waitFor", "until": "idle" }],
      "until": {
        "kind": "element",
        "target": { "strategies": [{ "kind": "css", "value": ".slot.available" }] }
      }
    },
    {
      "id": "s3",
      "type": "click",
      "target": { "strategies": [{ "kind": "css", "value": ".slot.available" }] }
    },
    {
      "id": "s4",
      "type": "fill",
      "target": { "strategies": [{ "kind": "css", "value": "#name" }] },
      "value": "{{profile.name}}"
    },
    {
      "id": "s5",
      "type": "fill",
      "target": { "strategies": [{ "kind": "css", "value": "#phone" }] },
      "value": "{{profile.phone}}"
    },
    {
      "id": "s6",
      "type": "if",
      "condition": {
        "kind": "element",
        "target": { "strategies": [{ "kind": "css", "value": "#agree" }] }
      },
      "then": [
        {
          "id": "s6a",
          "type": "check",
          "target": { "strategies": [{ "kind": "css", "value": "#agree" }] },
          "checked": true
        }
      ]
    },
    { "id": "s7", "type": "handoff", "message": "请确认信息并提交", "final": true }
  ]
}
```
