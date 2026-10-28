// 包装 vendor 里的 claude-bridge 客户端（原样复制，不改）。
// 扩展页面对 bridge 站点是跨域请求：注入带 credentials:'include' 的 fetch，带上门户会话 cookie。
// 扩展持有 bridge 站点的网站访问权限时，浏览器按同站处理，SameSite=Lax 的 cookie 也会带上。

import { BridgeAuthError, BridgeClient } from '../vendor/claude-bridge/bridge-client.js';

export { BridgeAuthError, BridgeClient };

export type BridgeStatus = 'ok' | 'signedOut' | 'unavailable' | 'notConfigured';

type FetchLike = (url: string, opts?: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (u, o) => fetch(u, o);

/** 规范化 bridge 地址：只接受 http(s)，去掉末尾斜杠；不合法或为空时返回 null */
export function normalizeBridgeUrl(url: string | undefined): string | null {
  const raw = url?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return raw.replace(/\/+$/, '');
}

export function createBridgeClient(baseUrl: string, fetchImpl: FetchLike = defaultFetch) {
  return new BridgeClient({
    baseUrl,
    fetch: (u, o) => fetchImpl(u, { ...o, credentials: 'include' }),
  });
}

/**
 * 调 bridge 的 /status：401（或被门卫重定向到门户登录页）视为未登录；
 * 网络错误、超时、5xx 视为不可用；没有配置地址时返回 notConfigured
 */
export async function bridgeStatus(
  baseUrl: string | undefined,
  {
    timeoutMs = 8000,
    fetchImpl = defaultFetch,
  }: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<BridgeStatus> {
  const base = normalizeBridgeUrl(baseUrl);
  if (!base) return 'notConfigured';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const client = createBridgeClient(base, async (u, o) => {
    const res = await fetchImpl(u, { ...o, signal: ctrl.signal, redirect: 'manual' });
    const redirected = res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
    return redirected ? new Response('{}', { status: 401 }) : res;
  });
  try {
    await client.status();
    return 'ok';
  } catch (e) {
    return e instanceof BridgeAuthError ? 'signedOut' : 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}
