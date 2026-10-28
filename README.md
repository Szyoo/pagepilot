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
- **请 AI 看看**：步骤失败暂停时，在侧边栏把中断的上下文（不含输入值与本地数据，截图可选）交给 [claude-bridge](https://github.com/Szyoo/claude-bridge) 分析，并可继续追问。
- **门户登录**：使用门户账号登录扩展（沿用门户会话，不保存密码与令牌），按账号权限下发规则。
- **本地数据保险库**：个人信息与账号凭据只保存在浏览器本机，不会上报；凭据绑定可用域名，规则中以占位符引用。

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

后台、门户与 AI 服务（claude-bridge）地址在构建时从本机 `.env` 读取（参考 `.env.example`，该文件不进仓库）：

```bash
cp .env.example .env   # 然后改成实际地址
pnpm build
```

配置后，这些站点的访问权限会直接写进扩展，设置页只需用门户账号登录；地址输入收在「高级」里，改了 `.env` 需要重新构建。
没有配置 `.env` 时，在设置页填写门户地址与后台地址，登录时会向你申请这两个站点的访问权限。
「请 AI 看看」的 claude-bridge 地址一般不用配置：登录后扩展从后台（`/api/ai/status`）自动获取，第一次使用时申请该站点的访问权限。`VITE_DEFAULT_BRIDGE_URL`（形如 `https://bridge.example.com/api`）是可选的，填了会写进网站权限，省掉这次授权弹窗；设置页「高级」里也可以手动覆盖。bridge 用门户会话 cookie 识别身份，需要先在普通网页里登录门户。
实时通道（SSE / 轮询 / WebSocket）也在设置页选择，默认 SSE（门户会话 cookie 为 `SameSite=Lax` 时 WebSocket 握手带不上它）。

## 文档

- [docs/architecture.md](docs/architecture.md)：架构、运行模型、认证与安全约束
- [docs/protocol.md](docs/protocol.md)：扩展与后台之间的消息协议
- [docs/rules.md](docs/rules.md)：规则格式

## 许可证

MIT
