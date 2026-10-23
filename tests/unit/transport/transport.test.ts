import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser, resetFakeBrowser } from '../../helpers/fake-browser';

vi.mock('wxt/browser', async () => (await import('../../helpers/fake-browser')).browserModule);
// 只替换会话校验，fetchWithSession 与错误类型用真实实现（底层 fetch 由各用例替换）
const { checkSession } = vi.hoisted(() => ({
  checkSession: vi.fn<() => Promise<string | null>>(),
}));
vi.mock('../../../src/transport/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/transport/auth')>()),
  checkSession,
}));

const { Transport } = await import('../../../src/transport');
type Deps = ConstructorParameters<typeof Transport>[0];

/** 最小的 WebSocket 替身：构造后异步触发 onopen，记录上行文本，可手动下发消息 */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: Record<string, unknown>[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(text: string) {
    this.sent.push(JSON.parse(text));
  }

  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  push(msg: unknown) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }

  kinds() {
    return this.sent.map((m) => m.kind);
  }
}

const env = { v: 1, id: 'd1' };
let transport: InstanceType<typeof Transport>;
let apply: ReturnType<typeof vi.fn>;
let statuses: unknown[];

function startTransport(lastSeq = 7): void {
  apply = vi.fn(async () => ({ type: 'applied', removedRuleIds: [] }));
  statuses = [];
  const deps: Deps = {
    apply: apply as unknown as Deps['apply'],
    lastSeq: async () => lastSeq,
    onStatus: (s) => statuses.push(s),
  };
  transport = new Transport(deps);
  transport.start();
}

async function connect(lastSeq = 7): Promise<FakeWebSocket> {
  startTransport(lastSeq);
  const ws = await vi.waitFor(() => {
    const w = FakeWebSocket.instances[0];
    if (!w?.kinds().includes('hello')) throw new Error('尚未连接');
    return w;
  });
  return ws;
}

beforeEach(() => {
  resetFakeBrowser();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  checkSession.mockReset();
  checkSession.mockResolvedValue('u1');
  fakeBrowser.storage.local.data.set('settings', { backendUrl: 'https://api.example.com/' });
});

afterEach(() => {
  transport?.stop();
  vi.unstubAllGlobals();
});

describe('Transport（WebSocket 最小路径）', () => {
  it('校验会话后直接连接 /api/ext/ws（不换取票据，URL 不带凭据），随后发送 hello', async () => {
    const ws = await connect(7);
    expect(checkSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch), '握手靠浏览器 cookie，不再请求 ws-ticket').not.toHaveBeenCalled();
    expect(ws.url).toBe('wss://api.example.com/api/ext/ws');
    expect(ws.sent[0]).toMatchObject({
      v: 1,
      kind: 'hello',
      ruleSchemaVersion: 1,
      lastSeq: 7,
      extVersion: '0.0.0-test',
    });
    expect(statuses).toContainEqual({ status: 'connected', channel: 'websocket' });
  });

  it('收到 snapshot 后应用并回复 ack', async () => {
    const ws = await connect();
    ws.push({ ...env, kind: 'snapshot', seq: 8, rules: [] });
    await vi.waitFor(() => expect(ws.kinds()).toContain('ack'));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(ws.sent.find((m) => m.kind === 'ack')).toMatchObject({ seq: 8 });
  });

  it('序号缺口时回复 resync，期间忽略增量消息，收到 snapshot 后恢复', async () => {
    const ws = await connect();
    apply.mockResolvedValueOnce({ type: 'gap' });
    ws.push({ ...env, kind: 'ruleRemove', seq: 20, ruleId: 'a' });
    await vi.waitFor(() => expect(ws.kinds()).toContain('resync'));
    expect(ws.kinds()).not.toContain('ack');

    ws.push({ ...env, kind: 'ruleRemove', seq: 21, ruleId: 'a' });
    await new Promise((r) => setTimeout(r, 10));
    expect(apply).toHaveBeenCalledTimes(1);

    ws.push({ ...env, kind: 'snapshot', seq: 22, rules: [] });
    await vi.waitFor(() => expect(ws.kinds()).toContain('ack'));
    ws.push({ ...env, kind: 'ruleRemove', seq: 23, ruleId: 'a' });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(3));
  });

  it('收到 ping 回复 pong，收到 pong 不回复', async () => {
    const ws = await connect();
    ws.push({ ...env, kind: 'ping' });
    await vi.waitFor(() => expect(ws.kinds()).toContain('pong'));
    const before = ws.sent.length;
    ws.push({ ...env, kind: 'pong' });
    await new Promise((r) => setTimeout(r, 10));
    expect(ws.sent.length).toBe(before);
  });

  it('无法解析或不符合协议的消息被忽略', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ws = await connect();
    const before = ws.sent.length;
    ws.push('not json');
    ws.push({ v: 1, id: 'x', kind: 'mystery' });
    await new Promise((r) => setTimeout(r, 10));
    expect(apply).not.toHaveBeenCalled();
    expect(ws.sent.length).toBe(before);
  });

  it('后台下发 error 消息时更新状态', async () => {
    const ws = await connect();
    ws.push({ ...env, kind: 'error', code: 'VERSION', message: '版本不兼容' });
    await vi.waitFor(() =>
      expect(statuses).toContainEqual({ status: 'error', error: '版本不兼容' }),
    );
  });

  it('send：瞬时消息不入队，业务消息入队并在连接可用时发出', async () => {
    const ws = await connect();
    await transport.send({ kind: 'ping' });
    expect(ws.kinds()).toContain('ping');
    expect(fakeBrowser.storage.local.data.get('uplinkQueue')).toBeUndefined();

    await transport.send({
      kind: 'capture',
      pageUrl: 'https://example.com/',
      title: 't',
      capturedAt: 1,
      elements: [],
    });
    expect(ws.kinds()).toContain('capture');
    expect(fakeBrowser.storage.local.data.get('uplinkQueue')).toEqual([]);
  });

  it('未配置后台地址时不连接并报告错误', async () => {
    fakeBrowser.storage.local.data.delete('settings');
    apply = vi.fn();
    statuses = [];
    transport = new Transport({
      apply: apply as unknown as Deps['apply'],
      lastSeq: async () => 0,
      onStatus: (s) => statuses.push(s),
    });
    transport.start();
    await vi.waitFor(() =>
      expect(statuses).toContainEqual({ status: 'error', error: '未配置后台地址' }),
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

/** 等待退避重试的上限：第一次失败后退避 2 秒 */
const RETRY_WAIT = { timeout: 5000 };

describe('Transport（门户会话）', () => {
  it('会话已失效（checkSession 返回 null）时进入 idle 并停止，不建立连接', async () => {
    checkSession.mockResolvedValue(null);
    startTransport();
    await vi.waitFor(() => expect(statuses).toEqual([{ status: 'idle' }]));
    await new Promise((r) => setTimeout(r, 50));
    expect(checkSession).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('会话校验遇到网络错误时报告错误并退避重试，恢复后连接', async () => {
    checkSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    startTransport();
    await vi.waitFor(() =>
      expect(statuses).toContainEqual({ status: 'error', error: 'Failed to fetch' }),
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
    await vi.waitFor(
      () => expect(statuses).toContainEqual({ status: 'connected', channel: 'websocket' }),
      RETRY_WAIT,
    );
    expect(checkSession).toHaveBeenCalledTimes(2);
  });

  it('WebSocket 以 4401 关闭时重新校验会话，失效则进入 idle 且不再重连', async () => {
    const ws = await connect();
    checkSession.mockResolvedValue(null);
    ws.close(4401);
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ status: 'idle' }), RETRY_WAIT);
    expect(checkSession).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('SSE 与上行都带 cookie、不带 Authorization；通道返回 401 时重新校验会话', async () => {
    fakeBrowser.storage.local.data.set('settings', {
      backendUrl: 'https://api.example.com',
      transport: 'sse',
    });
    let streamCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/ext/stream')) {
        streamCalls++;
        // 第一次连接成功但立即结束；之后会话已失效
        if (streamCalls === 1) return new Response(': ok\n\n', { status: 200 });
        return new Response(null, { status: 401 });
      }
      if (url.endsWith('/api/ext/uplink')) return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    });
    startTransport(3);
    await vi.waitFor(() =>
      expect(statuses).toContainEqual({ status: 'connected', channel: 'sse' }),
    );
    await vi.waitFor(() => expect(streamCalls).toBe(2), RETRY_WAIT);
    checkSession.mockResolvedValue(null);
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ status: 'idle' }), RETRY_WAIT);

    const calls = vi.mocked(fetch).mock.calls.map(([u, init]) => ({ url: String(u), init }));
    expect(calls[0]?.url).toBe('https://api.example.com/api/ext/stream?since=3');
    const hello = calls.find((c) => c.url.endsWith('/api/ext/uplink'));
    expect(JSON.parse(String(hello?.init?.body))).toMatchObject({ kind: 'hello', lastSeq: 3 });
    for (const c of calls) {
      expect(c.init).toMatchObject({ credentials: 'include', redirect: 'manual' });
      expect(new Headers(c.init?.headers).has('Authorization')).toBe(false);
    }
  });

  it('轮询返回 403 时报告无权使用并停止', async () => {
    fakeBrowser.storage.local.data.set('settings', {
      backendUrl: 'https://api.example.com',
      transport: 'poll',
    });
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 403 }));
    startTransport();
    await vi.waitFor(() =>
      expect(statuses.at(-1)).toEqual({ status: 'error', error: '当前账号无权使用扩展' }),
    );
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.example.com/api/ext/poll?since=7');
    expect(init).toMatchObject({ credentials: 'include', redirect: 'manual' });
    await new Promise((r) => setTimeout(r, 50));
    expect(checkSession).toHaveBeenCalledTimes(1);
  });
});
