// vendor 的 bridge-client.js 用裸 `new EventSource(url)` 订阅对话，跨域时默认不带 cookie，
// 会先连错几次再退回轮询。扩展持有 bridge 站点的网站访问权限，带上 cookie 即可直连：
// 在加载 vendor 之前把全局 EventSource 换成默认 withCredentials:true 的版本。只在侧边栏生效，不改 vendor 文件。
// 必须在侧边栏入口最先 import。
if (typeof EventSource !== 'undefined') {
  const Native = EventSource;
  class CredentialedEventSource extends Native {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, { withCredentials: true, ...init });
    }
  }
  (globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
    CredentialedEventSource;
}

export {};
