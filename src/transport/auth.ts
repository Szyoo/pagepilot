import { browser } from 'wxt/browser';
import { loadSettings } from '../shared/settings';
import { getItem, removeItem, setItem } from '../shared/storage';

/** 门户 OAuth 2.0 授权码 + PKCE。访问令牌只放 session，刷新令牌放 local。 */

interface AccessToken {
  token: string;
  expiresAt: number;
  userId: string;
}

const ACCESS = 'auth:access';
const REFRESH = 'auth:refresh';
const USER = 'auth:user';

export class AuthError extends Error {}

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function authBase(): Promise<{ base: string; clientId: string }> {
  const s = await loadSettings();
  const base = s.authUrl ?? s.backendUrl;
  if (!base) throw new AuthError('请先在设置页填写后台地址');
  return { base: base.replace(/\/+$/, ''), clientId: s.clientId };
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  user_id?: string;
}

function userIdOf(res: TokenResponse): string {
  if (res.user_id) return res.user_id;
  try {
    const payload = res.access_token.split('.')[1] ?? '';
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      sub?: string;
    };
    if (json.sub) return json.sub;
  } catch {
    // 不是 JWT
  }
  throw new AuthError('授权服务未返回用户标识');
}

async function store(res: TokenResponse): Promise<AccessToken> {
  const access: AccessToken = {
    token: res.access_token,
    expiresAt: Date.now() + res.expires_in * 1000,
    userId: userIdOf(res),
  };
  await setItem('session', ACCESS, access);
  await setItem('local', USER, access.userId);
  if (res.refresh_token) await setItem('local', REFRESH, res.refresh_token);
  return access;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const { base, clientId } = await authBase();
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...params }),
  });
  // 4xx 是授权服务明确拒绝；5xx 是服务端暂时故障，不应让用户被登出
  if (res.status >= 400 && res.status < 500) throw new AuthError(`授权服务返回 ${res.status}`);
  if (!res.ok) throw new Error(`授权服务暂时不可用（${res.status}）`);
  return (await res.json()) as TokenResponse;
}

export async function login(): Promise<string> {
  const { base, clientId } = await authBase();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirectUri = browser.identity.getRedirectURL();

  const url = new URL(`${base}/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();

  const redirected = await browser.identity.launchWebAuthFlow({
    url: url.toString(),
    interactive: true,
  });
  if (!redirected) throw new AuthError('登录已取消');
  const back = new URL(redirected);
  if (back.searchParams.get('state') !== state) throw new AuthError('登录状态校验失败');
  const code = back.searchParams.get('code');
  if (!code) throw new AuthError(back.searchParams.get('error') ?? '登录失败');

  const res = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  return (await store(res)).userId;
}

export async function logout(): Promise<void> {
  await removeItem('session', ACCESS);
  await removeItem('local', REFRESH);
  await removeItem('local', USER);
}

export async function currentUserId(): Promise<string | undefined> {
  return (await getItem<string | null>('local', USER, null)) ?? undefined;
}

let refreshing: Promise<AccessToken | null> | null = null;

async function refresh(): Promise<AccessToken | null> {
  const refreshToken = await getItem<string | null>('local', REFRESH, null);
  if (!refreshToken) return null;
  try {
    const res = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return await store(res);
  } catch (e) {
    if (e instanceof AuthError) {
      await logout();
      return null;
    }
    throw e; // 网络错误：保留登录状态，稍后重试
  }
}

/** 有效的访问令牌；临近过期时自动续期，失败返回 null（需要重新登录） */
export async function getAccessToken(force = false): Promise<AccessToken | null> {
  const cached = await getItem<AccessToken | null>('session', ACCESS, null);
  if (cached && !force && cached.expiresAt - Date.now() > 30_000) return cached;
  refreshing ??= refresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}
