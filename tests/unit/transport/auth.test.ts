import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser, resetFakeBrowser } from '../../helpers/fake-browser';

vi.mock('wxt/browser', async () => (await import('../../helpers/fake-browser')).browserModule);

const { getAccessToken, logout } = await import('../../../src/transport/auth');

const BASE = 'https://auth.example.com';
const fake = (prefix: string) => `${prefix}-${randomBytes(9).toString('base64url')}`;

interface StoredAccess {
  token: string;
  expiresAt: number;
  userId: string;
}

const session = () => fakeBrowser.storage.session.data;
const local = () => fakeBrowser.storage.local.data;
const access = () => session().get('auth:access') as StoredAccess | undefined;

function seed(opts: { token: string; expiresInMs: number; refresh?: string; user?: string }) {
  session().set('auth:access', {
    token: opts.token,
    expiresAt: Date.now() + opts.expiresInMs,
    userId: opts.user ?? 'u-old',
  });
  if (opts.refresh) local().set('auth:refresh', opts.refresh);
  local().set('auth:user', opts.user ?? 'u-old');
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** 构造未签名的 JWT，只用于测试读取 sub */
function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}

beforeEach(() => {
  resetFakeBrowser();
  local().set('settings', { backendUrl: BASE, clientId: 'pagepilot-test' });
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const fetchMock = () => vi.mocked(fetch);

/** 读取第 n 次刷新请求的表单参数 */
function formOf(call = 0): URLSearchParams {
  const init = fetchMock().mock.calls[call]?.[1];
  return new URLSearchParams(String(init?.body ?? ''));
}

describe('getAccessToken', () => {
  it('缓存有效时直接返回，不发请求', async () => {
    const token = fake('at');
    seed({ token, expiresInMs: 10 * 60_000, refresh: fake('rt') });
    const got = await getAccessToken();
    expect(got?.token).toBe(token);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('临近过期（<30s）时用刷新令牌续期，写入新令牌并更新刷新令牌', async () => {
    const oldRefresh = fake('rt');
    const newToken = fake('at');
    const newRefresh = fake('rt');
    seed({ token: fake('at'), expiresInMs: 10_000, refresh: oldRefresh });
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        access_token: newToken,
        refresh_token: newRefresh,
        expires_in: 3600,
        user_id: 'u-new',
      }),
    );

    const before = Date.now();
    const got = await getAccessToken();

    expect(fetchMock()).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock().mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/oauth/token`);
    expect(init?.method).toBe('POST');
    const form = formOf();
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token') === oldRefresh, '请求带上旧的刷新令牌').toBe(true);
    expect(form.get('client_id')).toBe('pagepilot-test');

    expect(got?.token === newToken).toBe(true);
    expect(got?.userId).toBe('u-new');
    expect(access()?.token === newToken, '新令牌写入 session').toBe(true);
    expect(access()?.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(local().get('auth:refresh') === newRefresh, '刷新令牌被更新').toBe(true);
    expect(local().get('auth:user')).toBe('u-new');
  });

  it('授权服务未返回新的刷新令牌时保留旧的', async () => {
    const oldRefresh = fake('rt');
    seed({ token: fake('at'), expiresInMs: 0, refresh: oldRefresh });
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ access_token: fake('at'), expires_in: 3600, user_id: 'u1' }),
    );
    await getAccessToken();
    expect(local().get('auth:refresh') === oldRefresh).toBe(true);
  });

  it('没有 user_id 时取 JWT 的 sub', async () => {
    seed({ token: fake('at'), expiresInMs: 0, refresh: fake('rt') });
    const token = jwt({ sub: 'u-from-sub', exp: 0 });
    fetchMock().mockResolvedValueOnce(jsonResponse({ access_token: token, expires_in: 60 }));
    const got = await getAccessToken();
    expect(got?.userId).toBe('u-from-sub');
    expect(local().get('auth:user')).toBe('u-from-sub');
  });

  it('既无 user_id 也无 sub 时视为授权失败：清除登录态并返回 null', async () => {
    // 实现里 userIdOf 抛出 AuthError，refresh() 捕获 AuthError 后登出
    seed({ token: fake('at'), expiresInMs: 0, refresh: fake('rt') });
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ access_token: fake('opaque'), expires_in: 60 }),
    );
    await expect(getAccessToken()).resolves.toBeNull();
    expect(access()).toBeUndefined();
    expect(local().has('auth:refresh')).toBe(false);
    expect(local().has('auth:user')).toBe(false);
  });

  it('并发调用只发一次刷新请求', async () => {
    seed({ token: fake('at'), expiresInMs: 5_000, refresh: fake('rt') });
    let release: (r: Response) => void = () => undefined;
    fetchMock().mockReturnValueOnce(
      new Promise<Response>((r) => {
        release = r;
      }),
    );
    const newToken = fake('at');
    const calls = [getAccessToken(), getAccessToken(), getAccessToken()];
    // 让三个调用都走到等待刷新的位置
    await vi.waitFor(() => expect(fetchMock()).toHaveBeenCalledTimes(1));
    release(jsonResponse({ access_token: newToken, expires_in: 3600, user_id: 'u1' }));
    const results = await Promise.all(calls);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r?.token === newToken)).toBe(true);

    // 刷新完成后新令牌有效，后续调用不再请求
    await getAccessToken();
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it('刷新被授权服务拒绝（4xx）时清除登录态并返回 null', async () => {
    seed({ token: fake('at'), expiresInMs: 0, refresh: fake('rt') });
    fetchMock().mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(getAccessToken()).resolves.toBeNull();
    expect(access()).toBeUndefined();
    expect(local().has('auth:refresh')).toBe(false);
    expect(local().has('auth:user')).toBe(false);
  });

  it('刷新遇到服务端 5xx 时抛出，且保留登录态', async () => {
    const refresh = fake('rt');
    seed({ token: fake('at'), expiresInMs: 0, refresh, user: 'u-keep' });
    fetchMock().mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503));
    await expect(getAccessToken()).rejects.toThrow('暂时不可用');
    expect(local().get('auth:refresh') === refresh).toBe(true);
    expect(local().get('auth:user')).toBe('u-keep');
  });

  it('刷新遇到网络错误时抛出，且保留登录态', async () => {
    const token = fake('at');
    const refresh = fake('rt');
    seed({ token, expiresInMs: 0, refresh, user: 'u-keep' });
    fetchMock().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(getAccessToken()).rejects.toThrow(TypeError);
    expect(access()?.token === token).toBe(true);
    expect(local().get('auth:refresh') === refresh).toBe(true);
    expect(local().get('auth:user')).toBe('u-keep');

    // 失败后不残留进行中的刷新，下一次调用会重新请求
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ access_token: fake('at'), expires_in: 3600, user_id: 'u-keep' }),
    );
    await expect(getAccessToken()).resolves.not.toBeNull();
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });

  it('没有刷新令牌且已过期时返回 null，不发请求', async () => {
    seed({ token: fake('at'), expiresInMs: 0 });
    await expect(getAccessToken()).resolves.toBeNull();
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('force=true 时绕过有效缓存强制续期', async () => {
    const oldToken = fake('at');
    const newToken = fake('at');
    seed({ token: oldToken, expiresInMs: 10 * 60_000, refresh: fake('rt') });
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ access_token: newToken, expires_in: 3600, user_id: 'u1' }),
    );
    const got = await getAccessToken(true);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(got?.token === newToken).toBe(true);
    expect(access()?.token === newToken).toBe(true);
  });

  it('未配置授权地址时视为无法续期：清除登录态并返回 null', async () => {
    local().delete('settings');
    seed({ token: fake('at'), expiresInMs: 0, refresh: fake('rt') });
    await expect(getAccessToken()).resolves.toBeNull();
    expect(fetchMock()).not.toHaveBeenCalled();
    expect(local().has('auth:refresh')).toBe(false);
  });
});

describe('logout', () => {
  it('清除访问令牌、刷新令牌与用户标识', async () => {
    seed({ token: fake('at'), expiresInMs: 60_000, refresh: fake('rt') });
    local().set('other', 1);
    await logout();
    expect(session().has('auth:access')).toBe(false);
    expect(local().has('auth:refresh')).toBe(false);
    expect(local().has('auth:user')).toBe(false);
    expect(local().get('other')).toBe(1);
  });
});
