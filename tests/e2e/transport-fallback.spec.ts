/// <reference types="chrome" />
// 传给 page.evaluate 的函数在扩展页面里执行，可以使用 chrome.* API

import { expect, test } from './fixtures';
import { captchaRule, slowRule } from './rules';

// 设置里 transport 为 'websocket'（signIn 默认），按 websocket → sse → poll 的顺序回退

test('WebSocket 不可用时回退到 SSE：hello 走 uplink 并带 lastSeq，规则同步且 ack 被记录', async ({
  backend,
  ext,
}) => {
  backend.fail.ws = true;
  await ext.signIn();

  const s = await ext.state();
  expect(s.connection).toMatchObject({ status: 'connected', channel: 'sse' });
  expect(backend.requests.ws, '先尝试过 WebSocket').toBeGreaterThan(0);
  expect(backend.wsConnections).toHaveLength(0);
  expect(backend.requests.stream[0]).toBe(0);

  // SSE 下 hello 通过 POST /api/ext/uplink 发送，首次连接 lastSeq 为 0
  const hello = await backend.received.waitFor('hello');
  expect(hello.lastSeq).toBe(0);
  expect(backend.requests.uplink).toContain('hello');

  const seq1 = backend.pushRule(captchaRule(backend.origin()));
  await ext.waitForState((st) => st.rules.some((r) => r.id === 'e2e-captcha'), 'SSE 收到规则');
  await expect
    .poll(() => backend.acks.includes(seq1), { message: 'ack 经 uplink 到达' })
    .toBe(true);
  expect(backend.requests.uplink).toContain('ack');

  // 断线期间下发第 2 条；重连仍走 SSE，hello 与 since 都带上已确认的序号
  backend.dropConnections();
  const seq2 = backend.pushRule(slowRule(backend.origin(), 1000));
  await backend.received.waitFor('hello', (m) => m.lastSeq === seq1);
  expect(backend.requests.stream).toContain(seq1);
  await ext.waitForState((st) => st.rules.length === 2, '重连后补发第 2 条规则');
  await expect.poll(() => backend.acks.includes(seq2)).toBe(true);
  const after = await ext.state();
  expect(after.connection).toMatchObject({ status: 'connected', channel: 'sse' });
  // SSE 与 uplink 都带着门户会话 cookie，没有请求因未认证被拒绝
  expect(backend.requests.unauthorized).toEqual([]);
});

test('WebSocket 与 SSE 都不可用时回退到轮询：首次轮询即拿到规则，不发 hello', async ({
  backend,
  ext,
}) => {
  backend.fail.ws = true;
  backend.fail.stream = true;
  // 连接前预置规则：建立轮询通道时会立即轮询一次
  const seq1 = backend.pushRule(captchaRule(backend.origin()));

  await ext.signIn({}, { waitHello: false });
  const s = await ext.state();
  expect(s.connection).toMatchObject({ status: 'connected', channel: 'poll' });
  expect(s.rules.map((r) => r.id)).toEqual(['e2e-captcha']);
  expect(backend.requests.ws).toBeGreaterThan(0);
  expect(backend.requests.stream.length).toBeGreaterThan(0);
  expect(backend.requests.poll[0], '首次轮询从 0 开始').toBe(0);
  await expect.poll(() => backend.acks.includes(seq1), { message: '轮询结果被确认' }).toBe(true);

  // 第 2 次轮询：修改设置触发重连（周期轮询最短 30 秒，不在测试里等待），since 为已确认序号
  const seq2 = backend.pushRule(slowRule(backend.origin(), 1000));
  const pollsBefore = backend.requests.poll.length;
  await ext.page.evaluate(async () => {
    const { settings } = (await chrome.storage.local.get('settings')) as {
      settings: Record<string, unknown>;
    };
    await chrome.storage.local.set({ settings: { ...settings, minRepeatIntervalMs: 2000 } });
  });
  await ext.waitForState((st) => st.rules.length === 2, '第 2 次轮询拿到增量');
  expect(backend.requests.poll.slice(pollsBefore)).toContain(seq1);
  await expect.poll(() => backend.acks.includes(seq2)).toBe(true);

  // 轮询通道以 since 表示进度，从不发送 hello
  expect(backend.received.of('hello')).toHaveLength(0);
  expect(backend.requests.uplink).not.toContain('hello');
  const after = await ext.state();
  expect(after.connection).toMatchObject({ status: 'connected', channel: 'poll' });
  expect(backend.requests.unauthorized).toEqual([]);
});
