# 规则格式

规则是一份 JSON，描述「在哪些页面、按什么步骤」自动执行。定义见 `src/schema/rule.ts`，安全约束见 [architecture.md](architecture.md#安全约束)。

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

| kind      | 字段                                                         | 成立条件                                                           |
| --------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `element` | `target`；可选 `visible`（默认 `true`）、`text`、`textMatch` | 元素存在（且可见）；给出 `text` 时文本包含该值，`textMatch` 为正则 |
| `url`     | `pattern`（glob）                                            | 当前页面 URL 匹配                                                  |
| `not`     | `condition`                                                  | 子条件不成立                                                       |
| `all`     | `conditions`                                                 | 全部成立                                                           |
| `any`     | `conditions`                                                 | 任一成立                                                           |

## 步骤

所有步骤共有字段：

| 字段        | 默认值  | 说明                         |
| ----------- | ------- | ---------------------------- |
| `id`        | 必填    | 规则内唯一（含嵌套步骤）     |
| `note`      | —       | 备注                         |
| `timeoutMs` | `15000` | 单次尝试的超时               |
| `retries`   | `0`     | 失败后的重试次数             |
| `optional`  | `false` | 失败时跳过而不是中断整条规则 |

### 页面操作

| type        | 字段                                      | 说明                                                |
| ----------- | ----------------------------------------- | --------------------------------------------------- |
| `open`      | `url`、`newTab`（默认 `false`）           | 打开页面                                            |
| `click`     | `target`                                  | 点击                                                |
| `fill`      | `target`、`value`、`clear`（默认 `true`） | 输入文本；唯一允许使用 `{{secret.x}}` 的位置        |
| `select`    | `target`、`value`                         | 选择下拉项（按值或显示文本）                        |
| `check`     | `target`、`checked`                       | 勾选 / 取消勾选                                     |
| `press`     | `key`、可选 `target`                      | 按键，如 `Enter`、`Control+A`                       |
| `switchTab` | `urlPattern`                              | 切换到 URL 匹配的已有标签页                         |
| `extract`   | `target`、`saveAs`、`attr`（默认取文本）  | 读取值保存为 `{{var.<saveAs>}}`，只在本次运行内有效 |

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
| `reload`        | `false`  | 每轮开始前刷新当前页面                                |
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
- 回放期间检测到人机验证组件时，会自动插入一次交还（`resumeWhen: condition`，条件为验证组件消失），无需在规则中显式编写。

### 嵌套限制

`if` 与 `repeat` 可以嵌套，最大深度 3 层。`login.steps` 中不能再包含 `login`。

## 占位符

文本字段中可使用以下占位符，全部在本机解析，不会上报：

| 占位符          | 来源                          | 允许出现的位置  |
| --------------- | ----------------------------- | --------------- |
| `{{profile.x}}` | 本地个人信息                  | 所有文本字段    |
| `{{secret.x}}`  | 本地凭据，绑定允许使用的域名  | 仅 `fill.value` |
| `{{var.x}}`     | 本次运行中 `extract` 保存的值 | 所有文本字段    |
- 解析失败（键不存在、保险库锁定、凭据域名不符）时，该步骤失败，不会把占位符原文填入页面。
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
