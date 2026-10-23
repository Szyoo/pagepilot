import { browser } from 'wxt/browser';
import { originPatternOf } from '../shared/glob';
import { loadSettings } from '../shared/settings';
import { getItem, removeItem, setItem } from '../shared/storage';

/**
 * 登录沿用门户的网页会话：扩展向门户登录接口提交账号密码，浏览器保存门户下发的会话 cookie，
 * 之后对后台的所有请求自动带上这个 cookie，后台（门卫）据此识别用户。
 * 扩展不保存令牌，也不保存密码；会话过期后重新登录即可。
 */

const USER = 'auth:user';

export class AuthError extends Error {}
/** 会话无效或已过期（401 或被重定向到登录页） */
export class Unauthorized extends Error {}
/** 已登录但无权使用扩展 */
export class Forbidden extends Error {}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

async function endpoints(): Promise<{ portal: string; backend: string | undefined }> {
  const s = await loadSettings();
  const backend = s.backendUrl ? trimUrl(s.backendUrl) : undefined;
  const portal = s.portalUrl ? trimUrl(s.portalUrl) : backend;
  if (!portal) throw new AuthError('请先在设置页填写门户地址');
  return { portal, backend };
}

/** 需要的网站访问权限：门户与后台所在的站点 */
export async function requiredOrigins(): Promise<string[]> {
  const s = await loadSettings();
  const urls = [s.portalUrl, s.backendUrl].filter((u): u is string => Boolean(u));
  return [
    ...new Set(
      urls
        .map((u) => originPatternOf(`${u.replace(/\/+$/, '')}/`))
        .filter((o): o is string => o !== null),
    ),
  ];
}

export async function hasOriginPermissions(): Promise<boolean> {
  const origins = await requiredOrigins();
  if (origins.length === 0) return false;
  return browser.permissions.contains({ origins });
}

/** 带会话 cookie 的请求；401 或被重定向（多半是登录页）视为会话失效 */
export async function fetchWithSession(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, credentials: 'include', redirect: 'manual' });
  if (res.type === 'opaqueredirect' || res.status === 401) throw new Unauthorized();
  if (res.status === 403) throw new Forbidden();
  return res;
}

export async function currentUserId(): Promise<string | undefined> {
  return (await getItem<string | null>('local', USER, null)) ?? undefined;
}

interface LoginResponse {
  ok?: boolean;
  id?: string | number;
  error?: string;
}

/** 用门户账号登录，返回用户标识 */
export async function login(username: string, password: string): Promise<string> {
  const { portal, backend } = await endpoints();
  if (!(await hasOriginPermissions())) throw new AuthError('请先授予门户与后台网站的访问权限');

  let res: Response;
  try {
    res = await fetch(`${portal}/api/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new AuthError('无法连接门户，请检查地址与网络');
  }
  const body = (await res.json().catch(() => ({}))) as LoginResponse;
  if (res.status === 429) throw new AuthError('尝试过于频繁，请稍后再试');
  if (body.error === 'account_expired') throw new AuthError('账号已过期');
  if (res.status === 401 || body.error === 'invalid_credentials') {
    throw new AuthError('账号或密码错误');
  }
  if (!res.ok || body.ok === false) throw new AuthError(`登录失败（${res.status}）`);

  // 以后台识别出的用户为准；后台尚未配置时用门户返回的标识
  let userId = body.id !== undefined ? String(body.id) : '';
  if (backend) {
    try {
      const me = await fetchMe(backend);
      if (me) userId = me;
    } catch (e) {
      // 后台不认门户会话，或账号无权使用：登录视为失败，避免之后第一次校验就把用户清掉
      if (e instanceof Unauthorized) {
        throw new AuthError('后台没有接受门户会话，请检查后台是否已接入门户登录');
      }
      if (e instanceof Forbidden) throw new AuthError('当前账号无权使用扩展');
      // 后台暂时不可用（网络错误、5xx）：先用门户返回的标识，后台恢复后以 sub 为准
    }
  }
  if (!userId) throw new AuthError('门户未返回用户标识');
  await setItem('local', USER, userId);
  return userId;
}

async function fetchMe(backend: string): Promise<string | null> {
  const res = await fetchWithSession(`${backend}/api/me`);
  if (!res.ok) throw new Error(`后台返回 ${res.status}`);
  const me = (await res.json().catch(() => ({}))) as { sub?: string };
  return me.sub ?? null;
}

export async function logout(): Promise<void> {
  try {
    const { portal } = await endpoints();
    await fetch(`${portal}/api/logout`, { method: 'POST', credentials: 'include' });
  } catch {
    // 即使门户不可达，本地也要登出
  }
  await removeItem('local', USER);
}

/**
 * 校验当前会话，返回用户标识；会话已失效返回 null（并清除本地登录状态）。
 * 网络错误与服务端故障会抛出，调用方应保留登录状态并稍后重试。
 */
export async function checkSession(): Promise<string | null> {
  const stored = await currentUserId();
  if (!stored) return null;
  const { backend } = await endpoints();
  if (!backend) throw new AuthError('请先在设置页填写后台地址');
  try {
    const sub = await fetchMe(backend);
    if (sub && sub !== stored) await setItem('local', USER, sub);
    return sub ?? stored;
  } catch (e) {
    if (e instanceof Unauthorized) {
      await removeItem('local', USER);
      return null;
    }
    throw e;
  }
}
