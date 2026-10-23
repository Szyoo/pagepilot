/// <reference types="chrome" />
// 传给 page.evaluate 的函数在扩展页面里执行，可以使用 chrome.* API

import type { RawRule } from './fake-backend';
import { type ExtensionHelper, fakeValue } from './fixtures';
import { SESSION_COOKIE } from './gate';
import { expect, SKIP_REASON, serverAvailable, test } from './real-backend.fixtures';
import { captchaRule, loginRule } from './rules';

// 扩展 ↔ 真实后台（server/）经假门卫的端到端测试。每个测试独立的后台进程与数据目录
test.skip(!serverAvailable(), SKIP_REASON);
test.describe.configure({ mode: 'serial' });

/** 会话失效后等待的时长：超过断线重连的 1 秒间隔与首次退避的 2 秒，用于确认不再重连 */
const NO_RECONNECT_WINDOW_MS = 3000;

interface RuleRow {
  rule: RawRule & { id: string; version: number };
  ownerSub: string;
  shared: boolean;
}

interface RunSummary {
  runId: string;
  ruleId: string;
  ruleVersion: number;
  status: string;
  trigger: string;
  inputMode: string;
  ownerSub: string;
}

/** 扩展本地缓存的规则序号 */
async function localSeq(ext: ExtensionHelper, uid: string): Promise<number | undefined> {
  return ext.page.evaluate(async (key) => {
    const v = (await chrome.storage.local.get(key))[key] as { lastSeq?: number } | undefined;
    return v?.lastSeq;
  }, `rules:${uid}`);
}

async function setTransport(ext: ExtensionHelper, patch: Record<string, unknown>): Promise<void> {
  await ext.page.evaluate(async (p) => {
    const { settings } = (await chrome.storage.local.get('settings')) as {
      settings: Record<string, unknown>;
    };
    await chrome.storage.local.set({ settings: { ...settings, ...p } });
  }, patch);
}

const versionOf = (s: { rules: { id: string; version: number }[] }, id: string) =>
  s.rules.find((r) => r.id === id)?.version;

test('规则下发（WebSocket）：管理接口新增、升级、删除实时推到扩展，序号连续且没有 resync', async ({
  gate,
  alice,
  ext,
}) => {
  await ext.signIn();
  const s0 = await ext.state();
  // 扩展以后台 /api/me 返回的 sub 为用户
  expect(s0.auth).toEqual({ status: 'signedIn', userId: alice.sub });
  expect(s0.connection).toMatchObject({ status: 'connected', channel: 'websocket' });
  expect(gate.requestsTo('/api/ext/ws', 101)).toHaveLength(1);
  expect(gate.uplinks('hello')).toEqual([{ kind: 'hello', channel: 'ws' }]);
  // 新用户首次连接走全量（空），本地序号为 0
  expect(await localSeq(ext, alice.sub)).toBe(0);

  const api = gate.asUser(alice.sub);
  const rule = captchaRule(gate.origin());
  expect((await api.put(`/api/rules/${rule.id}`, { rule })).status).toBe(200);
  let s = await ext.waitForState((st) => versionOf(st, 'e2e-captcha') === 1, '收到新规则');
  expect(s.rules).toHaveLength(1);
  expect(s.rules[0]).toMatchObject({ id: 'e2e-captcha', approved: false, stepCount: 2 });

  // 版本不升高：409，扩展不变
  expect((await api.put(`/api/rules/${rule.id}`, { rule })).status).toBe(409);

  const v2 = { ...rule, version: 2, name: '测试验证码交还 v2' };
  expect((await api.put(`/api/rules/${rule.id}`, { rule: v2 })).status).toBe(200);
  s = await ext.waitForState((st) => versionOf(st, 'e2e-captcha') === 2, '收到更新');
  expect(s.rules[0]?.name).toBe('测试验证码交还 v2');

  expect((await api.delete(`/api/rules/${rule.id}`)).status).toBe(204);
  await ext.waitForState((st) => st.rules.length === 0, '删除已同步');

  // 序号连续：三个事件 1..3 依次应用并确认，没有出现缺口触发 resync
  expect(await localSeq(ext, alice.sub)).toBe(3);
  expect(gate.userRow(alice.sub)?.seq).toBe(3);
  await expect.poll(() => gate.userRow(alice.sub)?.ackedSeq, { message: 'ack 到达后台' }).toBe(3);
  expect(gate.uplinks('resync')).toEqual([]);
  expect(gate.uplinks('ack').every((m) => m.channel === 'ws')).toBe(true);
  expect(gate.requestsTo('/api/ext/ws')).toHaveLength(1);
  expect(gate.requests.filter((r) => r.status === 401)).toEqual([]);
});

test('通道回退：设置为 SSE 与轮询时都能经真实后台同步规则', async ({ gate, alice, ext }) => {
  await ext.signIn({ transport: 'sse' });
  expect(await ext.state()).toMatchObject({ connection: { status: 'connected', channel: 'sse' } });
  // 首选 SSE 时不尝试 WebSocket；hello 经 POST /api/ext/uplink
  expect(gate.requestsTo('/api/ext/ws')).toHaveLength(0);
  expect(gate.requestsTo('/api/ext/stream', 200)).toHaveLength(1);
  expect(gate.uplinks('hello')).toEqual([{ kind: 'hello', channel: 'http' }]);

  const api = gate.asUser(alice.sub);
  const r1 = captchaRule(gate.origin());
  expect((await api.put(`/api/rules/${r1.id}`, { rule: r1 })).status).toBe(200);
  await ext.waitForState((st) => versionOf(st, 'e2e-captcha') === 1, 'SSE 收到规则');
  await expect.poll(() => gate.userRow(alice.sub)?.ackedSeq, { message: 'ack 经 uplink' }).toBe(1);

  // 改为轮询：设置变化触发重连，首次轮询即建立通道（不等 30 秒的周期轮询）
  await setTransport(ext, { transport: 'poll' });
  await ext.waitForState(
    (st) => st.connection.status === 'connected' && st.connection.channel === 'poll',
    '切换到轮询',
  );
  const pollsBefore = gate.requestsTo('/api/ext/poll', 200).length;
  expect(pollsBefore).toBeGreaterThan(0);

  const r2 = { ...r1, version: 2, name: '轮询拿到的版本' };
  expect((await api.put(`/api/rules/${r1.id}`, { rule: r2 })).status).toBe(200);
  // 再改一次设置触发重连，新会话的首次轮询拿到增量
  await setTransport(ext, { minRepeatIntervalMs: 2000 });
  await ext.waitForState((st) => versionOf(st, 'e2e-captcha') === 2, '轮询拿到增量');
  expect(gate.requestsTo('/api/ext/poll', 200).length).toBeGreaterThan(pollsBefore);
  await expect.poll(() => gate.userRow(alice.sub)?.ackedSeq, { message: '轮询结果被确认' }).toBe(2);

  expect(await localSeq(ext, alice.sub)).toBe(2);
  expect(gate.uplinks('resync')).toEqual([]);
  // 轮询通道不发 hello
  expect(gate.uplinks('hello')).toHaveLength(1);
  expect(gate.requests.filter((r) => r.status === 401)).toEqual([]);
});

test('运行并上报：确认并运行规则，后台运行报告与扩展一致且不含本地数据', async ({
  context,
  gate,
  alice,
  ext,
}) => {
  const name = fakeValue('user');
  const pass = fakeValue('pass');
  await ext.signIn();

  const api = gate.asUser(alice.sub);
  const rule = loginRule([gate.origin()]);
  expect((await api.put(`/api/rules/${rule.id}`, { rule })).status).toBe(200);
  await ext.waitForState((st) => st.rules.some((r) => r.id === 'e2e-login'), '收到规则');

  const page = await context.newPage();
  await page.goto(`${gate.origin()}/pages/login.html`);
  const tabId = await ext.tabIdOf(page);
  await ext.rpc('rule.approve', { ruleId: 'e2e-login' });
  await ext.saveVault({
    profile: { name },
    secret: { pass },
    secretOrigins: { pass: ['127.0.0.1'] },
  });

  const { runId } = await ext.rpc('run.start', { ruleId: 'e2e-login', tabId });
  const run = await ext.waitForRun(
    runId,
    (r) => r.status !== 'running' && r.status !== 'handoff',
    '运行结束',
  );
  expect(run.status).toBe('succeeded');
  await expect(page.getByTestId('user-menu')).toBeVisible();
  expect(gate.loginSubmissions).toHaveLength(1);
  const submitted = gate.loginSubmissions[0] ?? {};
  expect(submitted.user === name, '用户名与个人信息一致').toBe(true);
  expect(submitted.pass === pass, '密码与凭据一致').toBe(true);

  // 运行报告经扩展上报到后台
  let summary: RunSummary | undefined;
  await expect
    .poll(
      async () => {
        const res = await api.get<RunSummary[]>('/api/runs?ruleId=e2e-login');
        summary = res.body.find((r) => r.runId === runId);
        return summary !== undefined;
      },
      { message: '后台收到运行报告' },
    )
    .toBe(true);
  expect(summary).toMatchObject({
    runId,
    ruleId: 'e2e-login',
    ruleVersion: 1,
    status: run.status,
    trigger: 'manual',
    inputMode: 'synthetic',
    ownerSub: alice.sub,
  });

  const detail = await api.get<{ status: string; steps: { stepId: string; status: string }[] }>(
    `/api/runs/${runId}`,
  );
  expect(detail.status).toBe(200);
  expect(detail.body.status).toBe('succeeded');
  expect(detail.body.steps.map((x) => x.stepId)).toEqual(['s1', 's2', 's3', 's4']);
  expect(detail.body.steps.every((x) => x.status === 'succeeded')).toBe(true);

  // 后台存下的运行报告、以及数据库文件里都不含本地数据
  const stored = JSON.stringify(detail.body);
  expect(stored.includes(name), '运行报告不含个人信息').toBe(false);
  expect(stored.includes(pass), '运行报告不含凭据').toBe(false);
  const dbDump = gate.dumpDatabase();
  expect(dbDump.includes(name), '后台数据库不含个人信息').toBe(false);
  expect(dbDump.includes(pass), '后台数据库不含凭据').toBe(false);
  expect(gate.uplinks('runReport')).toHaveLength(1);
});

test('抓取与录制上报：后台列表里出现，录制生成规则后扩展收到并能运行', async ({
  context,
  gate,
  alice,
  ext,
}) => {
  const name = fakeValue('name');
  await ext.signIn();
  const api = gate.asUser(alice.sub);
  const pageUrl = `${gate.origin()}/pages/trusted.html`;

  // ---- 抓取 ----
  const page = await context.newPage();
  await page.goto(`${pageUrl}?token=${fakeValue('q')}`);
  const tabId = await ext.tabIdOf(page);
  const { count } = await ext.rpc('capture.page', { tabId });
  expect(count).toBeGreaterThan(0);
  let captures: { captureId: string; pageUrl: string; title: string; elementCount: number }[] = [];
  await expect
    .poll(
      async () => {
        captures = (await api.get<typeof captures>('/api/captures')).body;
        return captures.length;
      },
      { message: '后台收到抓取' },
    )
    .toBe(1);
  // 查询串可能带令牌，扩展只上报 origin + path
  expect(captures[0]).toMatchObject({ pageUrl, title: '输入事件', elementCount: count });
  const capture = await api.get<{ elements: unknown[] }>(`/api/captures/${captures[0]?.captureId}`);
  expect(capture.body.elements).toHaveLength(count);

  // ---- 录制 ----
  // 个人信息里的值在录制时替换为占位符
  await ext.saveVault({ profile: { name } });
  await page.goto(pageUrl);
  await ext.rpc('recording.start', { tabId });
  await ext.waitForState((st) => st.recording.status === 'recording', '开始录制');
  await page.click('#bump');
  await page.fill('#field', name);
  await page.press('#field', 'Enter');
  await page.click('#go');
  await expect(page.locator('#status')).toHaveText('clicked');
  const rec = await ext.waitForState((st) => st.recording.steps.length >= 5, '录到 5 步');
  expect(rec.recording.steps.map((x) => x.type)).toEqual([
    'open',
    'click',
    'fill',
    'press',
    'click',
  ]);
  await ext.rpc('recording.stop');
  await ext.rpc('recording.submit');

  let recordings: { recordingId: string; stepCount: number; ownerSub: string }[] = [];
  await expect
    .poll(
      async () => {
        recordings = (await api.get<typeof recordings>('/api/recordings')).body;
        return recordings.length;
      },
      { message: '后台收到录制' },
    )
    .toBe(1);
  expect(recordings[0]).toMatchObject({ stepCount: 5, ownerSub: alice.sub });
  const recordingId = recordings[0]?.recordingId ?? '';
  const recording = await api.get(`/api/recordings/${recordingId}`);
  expect(JSON.stringify(recording.body).includes(name), '录制不含个人信息的值').toBe(false);
  expect(JSON.stringify(recording.body)).toContain('{{profile.name}}');

  // ---- 录制生成规则 → 扩展收到 ----
  const created = await api.post<RuleRow>(`/api/recordings/${recordingId}/rule`, {
    id: 'e2e-recorded',
    name: '录制生成的规则',
    urls: [pageUrl],
  });
  expect(created.status).toBe(200);
  expect(created.body.rule).toMatchObject({
    id: 'e2e-recorded',
    version: 1,
    requires: { profile: ['name'] },
  });
  const s = await ext.waitForState(
    (st) => st.rules.some((r) => r.id === 'e2e-recorded'),
    '扩展收到录制生成的规则',
  );
  expect(s.rules.find((r) => r.id === 'e2e-recorded')).toMatchObject({
    version: 1,
    stepCount: 5,
    approved: false,
    requires: { profile: ['name'], secret: [] },
  });

  // 生成的规则能在新打开的测试页面上回放（先关掉录制用的页面，按 URL 找标签页时不混淆）
  await page.close();
  const target = await context.newPage();
  await target.goto(pageUrl);
  const targetTab = await ext.tabIdOf(target);
  await ext.rpc('rule.approve', { ruleId: 'e2e-recorded' });
  const { runId } = await ext.rpc('run.start', { ruleId: 'e2e-recorded', tabId: targetTab });
  const run = await ext.waitForRun(
    runId,
    (r) => r.status !== 'running' && r.status !== 'handoff',
    '回放结束',
  );
  expect(run.status).toBe('succeeded');
  await expect(target.locator('#status')).toHaveText('clicked');
  expect(await target.locator('#field').inputValue()).toBe(name);
  expect(gate.uplinks('resync')).toEqual([]);
});

test('多用户隔离：私有规则只给所有者，管理员共享后其他用户收到，取消共享后移除', async ({
  gate,
  alice,
  ext,
  openExtension,
}) => {
  const bob = gate.createUser('e2e-bob', 'user');
  const admin = gate.createUser('e2e-admin', 'admin');
  await ext.signIn();
  const second = await openExtension();
  await second.ext.signIn({}, { account: bob });
  await second.ext.waitForState((st) => st.auth.userId === bob.sub, 'B 以自己的 sub 登录');

  const asAlice = gate.asUser(alice.sub);
  const asBob = gate.asUser(bob.sub);
  const asAdmin = gate.asUser(admin.sub);
  const rule = captchaRule(gate.origin());

  expect((await asAlice.put(`/api/rules/${rule.id}`, { rule })).status).toBe(200);
  await ext.waitForState((st) => versionOf(st, 'e2e-captcha') === 1, 'A 收到私有规则');
  // B 看不到，也没有为 B 产生事件
  expect((await asBob.get<RuleRow[]>('/api/rules')).body).toEqual([]);
  expect(gate.userRow(bob.sub)?.seq).toBe(0);
  expect((await second.ext.state()).rules).toEqual([]);
  // B 不能改 A 的规则；普通用户不能共享
  expect((await asBob.put(`/api/rules/${rule.id}`, { rule: { ...rule, version: 9 } })).status).toBe(
    404,
  );
  expect(
    (await asAlice.put(`/api/rules/${rule.id}`, { rule: { ...rule, version: 9 }, shared: true }))
      .status,
  ).toBe(403);

  // 管理员设为共享：B 实时收到，A 收到新版本
  const v2 = { ...rule, version: 2 };
  expect((await asAdmin.put(`/api/rules/${rule.id}`, { rule: v2, shared: true })).status).toBe(200);
  await second.ext.waitForState((st) => versionOf(st, 'e2e-captcha') === 2, 'B 收到共享规则');
  await ext.waitForState((st) => versionOf(st, 'e2e-captcha') === 2, 'A 收到新版本');
  const shared = (await asBob.get<RuleRow[]>('/api/rules')).body;
  expect(shared.map((r) => [r.rule.id, r.ownerSub, r.shared])).toEqual([
    ['e2e-captcha', alice.sub, true],
  ]);

  // 取消共享：B 收到 ruleRemove，A 仍保留
  const v3 = { ...rule, version: 3 };
  expect((await asAdmin.put(`/api/rules/${rule.id}`, { rule: v3, shared: false })).status).toBe(
    200,
  );
  await second.ext.waitForState((st) => st.rules.length === 0, 'B 的规则被移除');
  await ext.waitForState((st) => versionOf(st, 'e2e-captcha') === 3, 'A 收到 v3');

  expect(await localSeq(second.ext, bob.sub)).toBe(2);
  expect(await localSeq(ext, alice.sub)).toBe(3);
  expect(gate.uplinks('resync')).toEqual([]);
});

test('会话失效：门卫让门户会话过期并断线后，扩展变为未登录且不再重连；重新登录后补发', async ({
  gate,
  alice,
  ext,
}) => {
  await ext.signIn();
  const api = gate.asUser(alice.sub);
  const r1 = captchaRule(gate.origin());
  expect((await api.put(`/api/rules/${r1.id}`, { rule: r1 })).status).toBe(200);
  await ext.waitForState((st) => st.rules.length === 1, '收到第 1 条规则');
  await expect.poll(() => gate.userRow(alice.sub)?.ackedSeq).toBe(1);

  gate.expireSessions();
  gate.dropConnections();
  await ext.waitForState(
    (st) => st.auth.status === 'signedOut' && st.connection.status === 'idle',
    '会话过期后变为未登录且连接空闲',
  );
  expect(gate.requestsTo('/api/me', 401).length).toBeGreaterThan(0);

  // 停止后不再尝试连接：观察一段超过重连间隔的时间
  const before = gate.requests.length;
  await ext.page.waitForTimeout(NO_RECONNECT_WINDOW_MS);
  expect(gate.requests.slice(before), '不再发起任何请求').toEqual([]);
  const idle = await ext.state();
  expect(idle.auth.status).toBe('signedOut');
  expect(idle.connection.status).toBe('idle');

  // 过期期间新增的规则在重新登录后补发（本地缓存仍在，hello 带已确认序号）
  const r2 = { ...captchaRule(gate.origin()), id: 'e2e-captcha-2' };
  expect((await api.put(`/api/rules/${r2.id}`, { rule: r2 })).status).toBe(200);
  const hellos = gate.uplinks('hello').length;
  await ext.signIn();
  await expect.poll(() => gate.uplinks('hello').length).toBeGreaterThan(hellos);
  await ext.waitForState((st) => st.rules.length === 2, '重新登录后补发第 2 条规则');
  expect(await localSeq(ext, alice.sub)).toBe(2);
  expect(gate.uplinks('resync')).toEqual([]);
});

test('管理页：带门户会话访问门卫地址，页面加载并列出规则，无控制台错误', async ({
  context,
  gate,
  alice,
}) => {
  const admin = gate.createUser('e2e-admin', 'admin');
  const shared = { ...captchaRule(gate.origin()), id: 'e2e-shared', name: '共享规则' };
  const priv = { ...captchaRule(gate.origin()), id: 'e2e-private', name: '私有规则' };
  expect(
    (await gate.asUser(admin.sub).put(`/api/rules/${shared.id}`, { rule: shared, shared: true }))
      .status,
  ).toBe(200);
  expect((await gate.asUser(alice.sub).put(`/api/rules/${priv.id}`, { rule: priv })).status).toBe(
    200,
  );

  // 门卫：没有会话 → 401；伪造身份头无效（被剥掉后按会话注入）
  const forged = { 'x-portal-sub': admin.sub, 'x-role': 'admin' };
  expect((await fetch(`${gate.url}/`, { headers: forged })).status).toBe(401);
  const me = await fetch(`${gate.url}/api/me`, {
    headers: { ...forged, cookie: `${SESSION_COOKIE}=${gate.issueSession(alice.sub)}` },
  });
  expect(await me.json()).toEqual({ sub: alice.sub, role: 'user' });

  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = m.location().url;
    // 浏览器自动请求的 /favicon.ico：管理页没有图标，后台返回 404，不算页面错误
    if (where && new URL(where).pathname === '/favicon.ico') return;
    errors.push(`${m.text()} @ ${where}`);
  });
  page.on('pageerror', (e) => errors.push(e.message));
  const failed: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });

  // 普通网页登录门户：cookie 存进浏览器
  const login = await page.request.post(`${gate.url}/api/login`, {
    data: { username: admin.username, password: admin.password },
  });
  expect(login.status()).toBe(200);
  await page.goto(`${gate.url}/`);

  await expect(page).toHaveTitle('PagePilot 管理');
  await expect(page.locator('#me')).toHaveText(`${admin.sub}（管理员）`);
  await expect(page.getByRole('tab')).toHaveText(['规则', '录制', '抓取', '运行报告']);
  await expect(page.getByRole('tab', { name: '规则' })).toHaveAttribute('aria-selected', 'true');
  // 管理员默认看到自己的与共享的规则
  const rows = page.locator('#main tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('e2e-shared');
  await expect(rows.first()).toContainText('共享');

  // 切换到其他标签页也能正常渲染（空列表）
  await page.getByRole('tab', { name: '运行报告' }).click();
  await expect(page.getByRole('tab', { name: '运行报告' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#main')).toContainText('暂无数据');
  await expect(page.locator('#error')).toBeHidden();
  expect(failed).toEqual([]);
  expect(errors).toEqual([]);
});
