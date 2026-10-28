# claude-bridge 浏览器端文件（第三方，原样复制）

| 文件 | 说明 |
|---|---|
| `bridge-client.js` | REST 调用与对话订阅（EventSource，失败时退回轮询） |
| `bridge-widget.js` | 参考聊天组件，`mountBridgeWidget(el, client, opts)` |
| `bridge-widget.css` | 组件样式，主题通过 `--bridge-*` 变量覆盖 |
| `LICENSE` | claude-bridge 的 MIT 许可 |
| `*.d.ts` | 本项目手写的最小类型声明（只声明用到的部分），不是上游文件 |

- 来源：[claude-bridge](https://github.com/Szyoo/claude-bridge) `v0.12.0`，路径 `src/claude_bridge/static/`
- 复制日期：2026-10-28
- 许可：MIT（见同目录 `LICENSE`）。`bridge-widget.js` / `bridge-widget.css` 中 Prompt Bar、Voice Pill 等部件移植自
  React Bits（MIT + Commons Clause），图标路径来自 Hugeicons 免费图标（MIT），说明保留在文件内的注释里。

## 约定

- 三个 `.js` / `.css` 文件**不做任何修改**，Biome 也不检查本目录（见 `biome.json`）。
- 随扩展一起打包，运行时不加载任何远程脚本或样式。
- 跨域身份（门户会话 cookie）由宿主处理：`src/shared/bridge.ts` 给 fetch 加 `credentials: 'include'`，
  `src/entrypoints/sidepanel/eventsource-credentials.ts` 让 EventSource 默认带 cookie。

## 升级

1. 在 claude-bridge 仓库里切到新的 tag，把上面三个文件与 `LICENSE` 原样复制过来：
   `git -C <claude-bridge> show vX.Y.Z:src/claude_bridge/static/bridge-widget.js > bridge-widget.js`（其余同理）。
2. 更新本文件里的版本号与复制日期。
3. 对照上游 README / CHANGELOG 检查 `mountBridgeWidget` 的参数与 `BridgeClient` 的方法，按需更新 `.d.ts`。
4. 跑 `pnpm exec tsc --noEmit` 与 `pnpm test:e2e`（`tests/e2e/fake-bridge.ts` 按 vendor 实际调用的接口实现）。
