# 规则格式

规则是一份 JSON，描述「在哪些页面、按什么步骤」自动执行。定义见 `src/schema/rule.ts`。

## 结构

- `match.urls`：URL glob 列表，命中即可触发。
- `requires`：声明需要的本地数据（`profile`、`secret`），缺失时提示用户先填写。
- `steps`：步骤列表，每步有 `id`、`timeoutMs`、`retries`、`optional`。

## 步骤类型

`open` `click` `fill` `select` `check` `press` `waitFor` `switchTab` `handoff` `assert` `extract`

## 定位器

每个目标可给出多条策略（`css` / `aria` / `text` / `xpath` / `testid`），按顺序回退，降低页面改版带来的失效。

## 占位符

文本值中可使用 `{{profile.x}}`、`{{secret.x}}`、`{{var.x}}`，在本机解析，不会上报。

## 人工交还

`handoff` 步骤暂停并提示用户，`resumeWhen` 可选用户确认、页面跳转或元素出现。
`final: true` 表示到此结束，把控制权完全交还用户。

## 示例

```json
{
  "id": "form-demo",
  "name": "表单流程示例",
  "version": 1,
  "match": { "urls": ["https://example.com/*"] },
  "requires": { "profile": ["name"], "secret": ["user", "pass"] },
  "steps": [
    { "id": "s1", "type": "open", "url": "https://example.com/login" },
    {
      "id": "s2",
      "type": "fill",
      "target": { "strategies": [{ "kind": "css", "value": "#user" }] },
      "value": "{{secret.user}}"
    },
    {
      "id": "s3",
      "type": "fill",
      "target": { "strategies": [{ "kind": "css", "value": "#pass" }] },
      "value": "{{secret.pass}}"
    },
    { "id": "s4", "type": "handoff", "message": "请完成验证", "resumeWhen": "navigation" },
    { "id": "s5", "type": "handoff", "message": "请选择时间", "final": true }
  ]
}
```
