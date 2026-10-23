import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser, resetFakeBrowser } from '../../helpers/fake-browser';

vi.mock('wxt/browser', async () => (await import('../../helpers/fake-browser')).browserModule);

const {
  AuthError,
  Forbidden,
  Unauthorized,
  checkSession,
  currentUserId,
  fetchWithSession,
  hasOriginPermissions,
  login,
  logout,
  requiredOrigins,
} = await import('../../../src/transport/auth');

const PORTAL = 'https://portal.example.com';
const BACKEND = 'https://api.example.com';
const PORTAL_ORIGIN = 'https://portal.example.com/*';
const BACKEND_ORIGIN = 'https://api.example.com/*';

const fake = (prefix: string) => `${prefix}-${randomBytes(9).toString('base64url')}`;

const local = () => fakeBrowser.storage.local.data;
const granted = () => fakeBrowser.permissions.granted;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** fetch 在 redirect: 'manual' 下遇到重定向时返回的响应（无法用构造函数生成） */
const opaqueRedirect = () =>
  ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() }) as Response;

function configure(settings: Record<string, unknown>, grant = true) {
  local().set('settings', settings);
  if (grant) {
    granted().add(PORTAL_ORIGIN);
    granted().add(BACKEND_ORIGIN);
  }
}

/** 存储里所有内容的序列化结果，用于检查密码没有落盘 */
function storageDump(): string {
  return JSON.stringify({
    local: Object.fromEntries(fakeBrowser.storage.local.data),
    session: Object.fromEntries(fakeBrowser.storage.session.data),
  });
}

const fetchMock = () => vi.mocked(fetch);
const callOf = (n: number) => {
  const [url, init] = fetchMock().mock.calls[n] ?? [];
  return { url: String(url), init: init ?? {} };
};

beforeEach(() => {
  resetFakeBrowser();
  vi.unstubAllEnvs();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requiredOrigins / hasOriginPermissions', () => {
  it('返回门户与后台站点的 match pattern，去掉端口并去重', async () => {
    configure({ portalUrl: `${PORTAL}/`, backendUrl: `${BACKEND}:8443/base/` }, false);
    expect(await requiredOrigins()).toEqual([PORTAL_ORIGIN, BACKEND_ORIGIN]);

    configure({ portalUrl: BACKEND, backendUrl: `${BACKEND}/` }, false);
    expect(await requiredOrigins()).toEqual([BACKEND_ORIGIN]);
  });

  it('未配置任何地址时视为没有权限', async () => {
    expect(await requiredOrigins()).toEqual([]);
    expect(await hasOriginPermissions()).toBe(false);
  });

  it('门户与后台都授予后才算有权限', async () => {
    configure({ portalUrl: PORTAL, backendUrl: BACKEND }, false);
    granted().add(PORTAL_ORIGIN);
    expect(await hasOriginPermissions()).toBe(false);
    granted().add(BACKEND_ORIGIN);
    expect(await hasOriginPermissions()).toBe(true);
  });
});

describe('login', () => {
  it('门户登录成功后以后台 /api/me 的 sub 为用户标识，且不保存密码', async () => {
    configure({ portalUrl: PORTAL, backendUrl: `${BACKEND}/` });
    const username = fake('user');
    const password = fake('pw');
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ ok: true, id: 42, user: username, role: 'member' }))
      .mockResolvedValueOnce(jsonResponse({ sub: 'u-sub' }));

    await expect(login(username, password)).resolves.toBe('u-sub');

    expect(fetchMock()).toHaveBeenCalledTimes(2);
    const portal = callOf(0);
    expect(portal.url).toBe(`${PORTAL}/api/login`);
    expect(portal.init.method).toBe('POST');
    expect(portal.init.credentials).toBe('include');
    expect(new Headers(portal.init.headers).get('Content-Type')).toBe('application/json');
    const body = JSON.parse(String(portal.init.body)) as Record<string, string>;
    expect(body.username === username && body.password === password, '提交账号与密码').toBe(true);

    const me = callOf(1);
    expect(me.url).toBe(`${BACKEND}/api/me`);
    expect(me.init.credentials).toBe('include');
    expect(me.init.redirect).toBe('manual');

    expect(local().get('auth:user')).toBe('u-sub');
    expect(await currentUserId()).toBe('u-sub');
    expect(storageDump().includes(password), '存储里不含密码').toBe(false);
    expect(storageDump()).not.toMatch(/token|cookie/i);
  });

  it('未配置后台时用门户返回的 id', async () => {
    configure({ portalUrl: PORTAL });
    fetchMock().mockResolvedValueOnce(jsonResponse({ ok: true, id: 42, user: 'a', role: 'r' }));
    await expect(login('a', fake('pw'))).resolves.toBe('42');
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(local().get('auth:user')).toBe('42');
  });

  it('未配置门户地址时向后台地址登录', async () => {
    configure({ backendUrl: `${BACKEND}/` });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ ok: true, id: 'p1' }))
      .mockResolvedValueOnce(jsonResponse({ sub: 'u1' }));
    await login('a', fake('pw'));
    expect(callOf(0).url).toBe(`${BACKEND}/api/login`);
  });

  it.each([
    ['服务端错误', () => jsonResponse({ error: 'x' }, 500)],
    ['网络错误', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('后台 /api/me 失败（%s）时回退到门户返回的 id', async (_name, me) => {
    configure({ portalUrl: PORTAL, backendUrl: BACKEND });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ ok: true, id: 'portal-7' }))
      .mockImplementationOnce(me as () => Promise<Response>);
    await expect(login('a', fake('pw'))).resolves.toBe('portal-7');
    expect(local().get('auth:user')).toBe('portal-7');
  });

  it.each([
    ['会话被拒绝（401）', () => jsonResponse({}, 401), '后台没有接受门户会话'],
    ['无权使用（403）', () => jsonResponse({}, 403), '当前账号无权使用扩展'],
  ])('后台 /api/me 返回 %s 时登录失败，不写入登录状态', async (_name, me, message) => {
    configure({ portalUrl: PORTAL, backendUrl: BACKEND });
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ ok: true, id: 'portal-7' }))
      .mockImplementationOnce(me as unknown as () => Promise<Response>);
    await expect(login('a', fake('pw'))).rejects.toThrow(message);
    expect(local().has('auth:user')).toBe(false);
  });

  it.each([
    ['401', () => jsonResponse({}, 401), '账号或密码错误'],
    [
      'invalid_credentials',
      () => jsonResponse({ error: 'invalid_credentials' }, 400),
      '账号或密码错误',
    ],
    ['account_expired', () => jsonResponse({ error: 'account_expired' }, 403), '账号已过期'],
    ['429', () => jsonResponse({ error: 'rate_limited' }, 429), '尝试过于频繁'],
    ['500', () => jsonResponse({}, 500), '登录失败（500）'],
    ['非 JSON 的 502', () => new Response('bad gateway', { status: 502 }), '登录失败（502）'],
    ['ok: false', () => jsonResponse({ ok: false }), '登录失败（200）'],
    ['网络错误', () => Promise.reject(new TypeError('Failed to fetch')), '无法连接门户'],
  ])('门户返回 %s 时抛出 AuthError 并保持未登录', async (_name, res, message) => {
    configure({ portalUrl: PORTAL, backendUrl: BACKEND });
    fetchMock().mockImplementationOnce(res as () => Promise<Response>);
    const err = await login('a', fake('pw')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as Error).message).toContain(message);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(local().has('auth:user')).toBe(false);
  });

  it('门户与后台都没有给出用户标识时登录失败', async () => {
    configure({ portalUrl: PORTAL });
    fetchMock().mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(login('a', fake('pw'))).rejects.toThrow('门户未返回用户标识');
    expect(local().has('auth:user')).toBe(false);
  });

  it('未授予网站访问权限时抛出 AuthError，不发任何请求', async () => {
    configure({ portalUrl: PORTAL, backendUrl: BACKEND }, false);
    granted().add(PORTAL_ORIGIN); // 只授予了门户
    const err = await login('a', fake('pw')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as Error).message).toContain('访问权限');
    expect(fetchMock()).not.toHaveBeenCalled();
    expect(local().has('auth:user')).toBe(false);
  });

  it('未配置门户与后台地址时抛出 AuthError', async () => {
    await expect(login('a', fake('pw'))).rejects.toBeInstanceOf(AuthError);
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});

describe('checkSession', () => {
  beforeEach(() => {
    configure({ portalUrl: PORTAL, backendUrl: `${BACKEND}/` });
  });

  it('没有本地用户时返回 null，不发请求', async () => {
    await expect(checkSession()).resolves.toBeNull();
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('会话有效时返回 sub，请求带 cookie 且不跟随重定向', async () => {
    local().set('auth:user', 'u1');
    fetchMock().mockResolvedValueOnce(jsonResponse({ sub: 'u1', role: 'member' }));
    await expect(checkSession()).resolves.toBe('u1');
    const me = callOf(0);
    expect(me.url).toBe(`${BACKEND}/api/me`);
    expect(me.init.credentials).toBe('include');
    expect(me.init.redirect).toBe('manual');
    expect(local().get('auth:user')).toBe('u1');
  });

  it('后台识别出的用户与本地不同时更新本地用户标识', async () => {
    local().set('auth:user', 'portal-7');
    fetchMock().mockResolvedValueOnce(jsonResponse({ sub: 'u-new' }));
    await expect(checkSession()).resolves.toBe('u-new');
    expect(local().get('auth:user')).toBe('u-new');
  });

  it('后台未返回 sub 时沿用本地用户标识', async () => {
    local().set('auth:user', 'u1');
    fetchMock().mockResolvedValueOnce(jsonResponse({}));
    await expect(checkSession()).resolves.toBe('u1');
    expect(local().get('auth:user')).toBe('u1');
  });

  it.each([
    ['401', () => jsonResponse({}, 401)],
    ['被重定向到登录页', opaqueRedirect],
  ])('会话失效（%s）时清除本地用户并返回 null', async (_name, res) => {
    local().set('auth:user', 'u1');
    local().set('other', 1);
    fetchMock().mockResolvedValueOnce(res());
    await expect(checkSession()).resolves.toBeNull();
    expect(local().has('auth:user')).toBe(false);
    expect(local().get('other')).toBe(1);
  });

  it('后台 5xx 时抛出并保留登录状态', async () => {
    local().set('auth:user', 'u1');
    fetchMock().mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503));
    await expect(checkSession()).rejects.toThrow('503');
    expect(local().get('auth:user')).toBe('u1');
  });

  it('网络错误时抛出并保留登录状态', async () => {
    local().set('auth:user', 'u1');
    fetchMock().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(checkSession()).rejects.toThrow(TypeError);
    expect(local().get('auth:user')).toBe('u1');
  });

  it('403（无权使用扩展）时抛出 Forbidden 并保留登录状态', async () => {
    local().set('auth:user', 'u1');
    fetchMock().mockResolvedValueOnce(jsonResponse({}, 403));
    await expect(checkSession()).rejects.toBeInstanceOf(Forbidden);
    expect(local().get('auth:user')).toBe('u1');
  });

  it('未配置后台地址时抛出并保留登录状态', async () => {
    local().set('settings', { portalUrl: PORTAL });
    local().set('auth:user', 'u1');
    await expect(checkSession()).rejects.toBeInstanceOf(AuthError);
    expect(fetchMock()).not.toHaveBeenCalled();
    expect(local().get('auth:user')).toBe('u1');
  });
});

describe('fetchWithSession', () => {
  it('带上 cookie、不跟随重定向，并保留调用方的参数', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ ok: true }));
    const res = await fetchWithSession(`${BACKEND}/api/ext/uplink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const { url, init } = callOf(0);
    expect(url).toBe(`${BACKEND}/api/ext/uplink`);
    expect(init).toMatchObject({
      method: 'POST',
      body: '{}',
      credentials: 'include',
      redirect: 'manual',
    });
  });

  it('调用方无法关闭 cookie 或改为跟随重定向', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({}));
    await fetchWithSession(`${BACKEND}/x`, { credentials: 'omit', redirect: 'follow' });
    expect(callOf(0).init).toMatchObject({ credentials: 'include', redirect: 'manual' });
  });

  it('401 抛出 Unauthorized', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({}, 401));
    await expect(fetchWithSession(`${BACKEND}/x`)).rejects.toBeInstanceOf(Unauthorized);
  });

  it('被重定向（opaqueredirect）抛出 Unauthorized', async () => {
    fetchMock().mockResolvedValueOnce(opaqueRedirect());
    await expect(fetchWithSession(`${BACKEND}/x`)).rejects.toBeInstanceOf(Unauthorized);
  });

  it('403 抛出 Forbidden', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({}, 403));
    await expect(fetchWithSession(`${BACKEND}/x`)).rejects.toBeInstanceOf(Forbidden);
  });

  it('其他错误状态原样返回，由调用方处理', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({}, 500));
    const res = await fetchWithSession(`${BACKEND}/x`);
    expect(res.status).toBe(500);
  });
});

describe('logout', () => {
  it('通知门户登出并清除本地用户，其他数据保留', async () => {
    configure({ portalUrl: `${PORTAL}/`, backendUrl: BACKEND });
    local().set('auth:user', 'u1');
    local().set('other', 1);
    fetchMock().mockResolvedValueOnce(jsonResponse({ ok: true }));
    await logout();
    const { url, init } = callOf(0);
    expect(url).toBe(`${PORTAL}/api/logout`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(local().has('auth:user')).toBe(false);
    expect(local().get('other')).toBe(1);
  });

  it('门户不可达时仍清除本地用户', async () => {
    configure({ portalUrl: PORTAL });
    local().set('auth:user', 'u1');
    fetchMock().mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(logout()).resolves.toBeUndefined();
    expect(local().has('auth:user')).toBe(false);
  });

  it('未配置地址时不发请求，仍清除本地用户', async () => {
    local().set('auth:user', 'u1');
    await logout();
    expect(fetchMock()).not.toHaveBeenCalled();
    expect(local().has('auth:user')).toBe(false);
  });
});
