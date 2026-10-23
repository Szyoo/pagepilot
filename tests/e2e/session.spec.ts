/// <reference types="chrome" />
// 传给 page.evaluate 的函数在扩展页面里执行，可以使用 chrome.* API

import { SESSION_COOKIE } from './fake-backend';
import { expect, fakeValue, test } from './fixtures';
import { captchaRule, slowRule } from './rules';

/** 会话失效后等待的时长：超过断线重连的 1 秒间隔与首次退避的 2 秒，用于确认不再重连 */
const NO_RECONNECT_WINDOW_MS = 3000;

test('门户账号登录：错误密码失败且保持未登录；正确密码登录后以后台 sub 为用户并连上', async ({
  backend,
  context,
  ext,
}) => {
  await ext.configure();

  // 错误密码：门户返回 401 invalid_credentials
  await expect(
    ext.rpc('auth.login', { username: backend.account.username, password: fakeValue('wrong') }),
  ).rejects.toThrow('账号或密码错误');
  const failed = await ext.state();
  expect(failed.auth.status).toBe('signedOut');
  expect(failed.connection.status).toBe('idle');
  expect(backend.requests.login).toEqual(['invalid']);
  expect(backend.sessionCount).toBe(0);

  await ext.signIn();
  const s = await ext.state();
  // 门户返回的 id 与后台 /api/me 的 sub 不同，扩展以后台识别出的用户为准
  expect(s.auth).toEqual({ status: 'signedIn', userId: backend.sub });
  expect(s.connection).toMatchObject({ status: 'connected', channel: 'websocket' });
  expect(backend.requests.login).toEqual(['invalid', 'ok']);
  expect(backend.requests.me).toBeGreaterThan(0);
  // /api/me 与 WebSocket 握手都带上了门户会话 cookie
  expect(backend.requests.ws).toBe(1);
  expect(backend.requests.unauthorized).toEqual([]);

  // cookie 保存在浏览器里（扩展本身不保存），属性与后台下发的一致
  const cookie = (await context.cookies(backend.url)).find((c) => c.name === SESSION_COOKIE);
  expect(cookie, '浏览器保存了门户会话 cookie').toBeDefined();
  expect(cookie).toMatchObject({
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  });

  // 扩展存储里没有密码，也没有会话 cookie 的值
  const dump = await ext.page.evaluate(async () =>
    JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null)]),
  );
  expect(dump.includes(backend.account.password), '扩展存储里不含密码').toBe(false);
  expect(dump.includes(cookie?.value ?? '<none>'), '扩展存储里不含 cookie 值').toBe(false);

  // 已登录后规则同步正常
  backend.pushRule(captchaRule(backend.origin()));
  await ext.waitForState((st) => st.rules.some((r) => r.id === 'e2e-captcha'), '收到规则');
});

test('会话过期后断线：重连前校验会话失败 → 未登录、idle 且不再重连；重新登录后恢复同步', async ({
  backend,
  ext,
}) => {
  await ext.signIn();
  const seq1 = backend.pushRule(captchaRule(backend.origin()));
  await ext.waitForState((st) => st.rules.length === 1, '收到第 1 条规则');
  await expect.poll(() => backend.acks.includes(seq1)).toBe(true);

  backend.expireSessions();
  backend.dropConnections();
  await ext.waitForState(
    (st) => st.auth.status === 'signedOut' && st.connection.status === 'idle',
    '会话过期后变为未登录且连接空闲',
  );
  expect(backend.requests.unauthorized).toContain('/api/me');

  // 停止后不再尝试连接：观察一段超过重连间隔的时间
  const wsBefore = backend.requests.ws;
  const meBefore = backend.requests.me;
  await ext.page.waitForTimeout(NO_RECONNECT_WINDOW_MS);
  expect(backend.requests.ws, '不再发起 WebSocket 握手').toBe(wsBefore);
  expect(backend.requests.me, '不再校验会话').toBe(meBefore);
  expect(backend.connectedClients).toBe(0);
  const idle = await ext.state();
  expect(idle.auth.status).toBe('signedOut');
  expect(idle.connection.status).toBe('idle');

  // 过期期间下发的规则在重新登录后补发；同一用户的规则缓存仍在，hello 带上已确认的序号
  const seq2 = backend.pushRule(slowRule(backend.origin(), 1000));
  const hellosBefore = backend.received.of('hello').length;
  await ext.signIn();
  await expect.poll(() => backend.received.of('hello').length).toBeGreaterThan(hellosBefore);
  expect(backend.received.of('hello').at(-1)?.lastSeq).toBe(seq1);
  await ext.waitForState((st) => st.rules.length === 2, '重新登录后补发第 2 条规则');
  await expect.poll(() => backend.acks.includes(seq2)).toBe(true);
});

test('会话过期时后台以 4401 关闭 WebSocket：重新校验后变为未登录并停止', async ({
  backend,
  ext,
}) => {
  await ext.signIn();
  backend.expireSessions({ closeCode: 4401 });
  await ext.waitForState(
    (st) => st.auth.status === 'signedOut' && st.connection.status === 'idle',
    '4401 后重新校验会话并停止',
  );
  expect(backend.requests.unauthorized).toContain('/api/me');
  expect(backend.requests.ws, '没有带着失效会话重连').toBe(1);
});

test('登出：通知门户、本地变为未登录并清空规则缓存，重新登录后从全量开始', async ({
  backend,
  context,
  ext,
}) => {
  await ext.signIn();
  const seq1 = backend.pushRule(captchaRule(backend.origin()));
  await ext.waitForState((st) => st.rules.length === 1, '收到规则');
  await expect.poll(() => backend.acks.includes(seq1)).toBe(true);

  await ext.rpc('auth.logout');
  const s = await ext.state();
  expect(s.auth.status).toBe('signedOut');
  expect(s.connection.status).toBe('idle');
  expect(s.rules).toEqual([]);
  expect(backend.requests.logout).toBe(1);
  expect(backend.sessionCount, '门户会话已注销').toBe(0);
  // 门户在登出响应里清除了 cookie
  const cookies = await context.cookies(backend.url);
  expect(cookies.some((c) => c.name === SESSION_COOKIE)).toBe(false);

  const stored = await ext.page.evaluate(async (key) => {
    const all = await chrome.storage.local.get(null);
    return { user: all['auth:user'], cache: all[key] };
  }, `rules:${backend.sub}`);
  expect(stored.user).toBeUndefined();
  expect(stored.cache).toEqual({ rules: {}, lastSeq: 0 });

  // 重新登录：缓存已清空，hello 从 0 开始，后台下发全量
  const hellosBefore = backend.received.of('hello').length;
  await ext.signIn();
  await expect.poll(() => backend.received.of('hello').length).toBeGreaterThan(hellosBefore);
  expect(backend.received.of('hello').at(-1)?.lastSeq).toBe(0);
  await ext.waitForState((st) => st.rules.length === 1, '重新登录后收到全量规则');
});

test.describe('门户 cookie 为 SameSite=Lax', () => {
  test.use({ backendOptions: { cookieSameSite: 'Lax' } });

  test('扩展的 fetch 带 cookie，但 WebSocket 握手不带：回退到 SSE 后仍能同步', async ({
    backend,
    ext,
  }) => {
    await ext.signIn();
    const s = await ext.state();
    expect(s.auth).toEqual({ status: 'signedIn', userId: backend.sub });
    expect(s.connection).toMatchObject({ status: 'connected', channel: 'sse' });
    // 只有 WebSocket 握手因缺少 cookie 被拒绝；/api/me、SSE、uplink 都带着 cookie
    expect(backend.requests.ws).toBeGreaterThan(0);
    expect(backend.wsConnections).toHaveLength(0);
    expect(new Set(backend.requests.unauthorized)).toEqual(new Set(['/api/ext/ws']));
    expect(backend.requests.uplink).toContain('hello');

    const seq = backend.pushRule(captchaRule(backend.origin()));
    await ext.waitForState((st) => st.rules.length === 1, 'SSE 收到规则');
    await expect.poll(() => backend.acks.includes(seq)).toBe(true);
  });
});
