import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser, resetFakeBrowser } from '../../helpers/fake-browser';

vi.mock('wxt/browser', async () => (await import('../../helpers/fake-browser')).browserModule);
vi.mock('../../../src/transport/auth', () => ({
  getAccessToken: vi.fn(async () => ({ token: 'tok', userId: 'u1', expiresAt: Date.now() + 1e6 })),
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

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
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

async function connect(lastSeq = 7): Promise<FakeWebSocket> {
  apply = vi.fn(async () => ({ type: 'applied', removedRuleIds: [] }));
  statuses = [];
  const deps: Deps = {
    apply: apply as unknown as Deps['apply'],
    lastSeq: async () => lastSeq,
    onStatus: (s) => statuses.push(s),
  };
  transport = new Transport(deps);
  transport.start();
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
    vi.fn(
      async () => new Response(JSON.stringify({ ticket: 'tk 1', expiresIn: 30 }), { status: 200 }),
    ),
  );
  fakeBrowser.storage.local.data.set('settings', { backendUrl: 'https://api.example.com/' });
});

afterEach(() => {
  transport?.stop();
  vi.unstubAllGlobals();
});

describe('Transport（WebSocket 最小路径）', () => {
  it('先换取票据再连接，URL 带编码后的 ticket，随后发送 hello', async () => {
    const ws = await connect(7);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('https://api.example.com/api/ext/ws-ticket');
    expect(ws.url).toBe('wss://api.example.com/api/ext/ws?ticket=tk%201');
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
