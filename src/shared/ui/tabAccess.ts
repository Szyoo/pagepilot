import { browser } from 'wxt/browser';

/**
 * 抓取、录制要往当前页面注入脚本，需要该网站的访问权限。
 * 必须在用户点击的处理函数里调用（权限申请需要用户手势），已授权时不会弹窗。
 */
export async function ensureTabAccess(tab: { url?: string | undefined }): Promise<void> {
  let url: URL;
  try {
    url = new URL(tab.url ?? '');
  } catch {
    throw new Error('找不到当前页面的地址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('这个页面不支持（浏览器内置页面、本地文件或扩展页面）');
  }
  if (url.hostname === 'chromewebstore.google.com') {
    throw new Error('Chrome 应用商店页面不允许扩展访问');
  }
  const origins = [`${url.protocol}//${url.hostname}/*`];
  if (await browser.permissions.contains({ origins })) return;
  const granted = await browser.permissions.request({ origins });
  if (!granted) throw new Error(`需要授予 ${url.hostname} 的访问权限，才能抓取或录制这个页面`);
}
