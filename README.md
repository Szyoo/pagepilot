# PagePilot

可配置、云端下发的网页自动化 Chrome 扩展。

## 功能

- **页面抓取**：抓取当前页面的元素信息（定位器、文本、属性），上报到可配置的后台地址。
- **操作录制**：录制点击、输入、跨页面、跨标签页的连续操作，连同元素信息一起上报。
- **规则下发**：后台将录制结果固化为规则，通过实时通道推送到扩展，无需更新扩展本身。
- **规则回放**：按 URL 匹配规则执行，支持等待、条件分支、重试、失败上报。
- **反复执行**：按间隔刷新或重复操作，直到页面满足指定条件（如出现可预约名额），满足后通知用户。
- **真实输入**：可选通过浏览器调试接口发送真实的鼠标与键盘事件，按站点选择。
- **人工交还**：遇到人机验证、需要人工决策的环节时暂停，交还给用户，完成后可继续。
- **门户登录**：使用门户账号登录扩展，按账号权限下发规则。
- **本地数据保险库**：个人信息与账号凭据只保存在浏览器本机，以主密码加密，不会上报；凭据绑定可用域名，规则中以占位符引用。

## 技术栈

WXT 0.21 · TypeScript 7 · React 19 · Tailwind CSS 4 · Zod 4 · Vitest 5 · Playwright · Biome

## 安装与运行

需要 Node.js ≥ 24 与 pnpm。

```bash
pnpm install
pnpm dev        # 开发模式，自动加载到 Chrome
pnpm build      # 产物位于 .output/chrome-mv3
pnpm test       # 单元测试
pnpm check      # 格式与静态检查
```

构建后在 `chrome://extensions` 开启开发者模式，加载 `.output/chrome-mv3` 目录。

## 配置

在扩展设置页填写后台地址，使用门户账号登录，并选择实时通道（WebSocket / SSE / 轮询）。
构建期默认值可参考 `.env.example`。

## 文档

- [docs/architecture.md](docs/architecture.md)：架构、运行模型、认证与安全约束
- [docs/protocol.md](docs/protocol.md)：扩展与后台之间的消息协议
- [docs/rules.md](docs/rules.md)：规则格式

## 许可证

MIT
