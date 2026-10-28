import { describe, expect, it, vi } from 'vitest';
import { bridgeStatus, createBridgeClient, normalizeBridgeUrl } from '../../../src/shared/bridge';

const BASE = 'https://bridge.example.com/api';

const respond = (status: number, body: unknown = {}) =>
  vi.fn(async (_u: string, _o?: RequestInit) => new Response(JSON.stringify(body), { status }));

describe('bridgeStatus', () => {
  it('没有配置或地址不合法时返回 notConfigured，不发请求', async () => {
    const f = respond(200);
    expect(await bridgeStatus(undefined, { fetchImpl: f })).toBe('notConfigured');
    expect(await bridgeStatus('  ', { fetchImpl: f })).toBe('notConfigured');
    expect(await bridgeStatus('ftp://bridge.example.com', { fetchImpl: f })).toBe('notConfigured');
    expect(f).not.toHaveBeenCalled();
  });

  it('200 → ok；请求 /status 并带上 cookie', async () => {
    const f = respond(200, { online: true });
    expect(await bridgeStatus(`${BASE}/`, { fetchImpl: f })).toBe('ok');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, opts] = f.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/status`);
    expect(opts?.credentials).toBe('include');
    expect(opts?.redirect).toBe('manual');
  });

  it('401 或被重定向（门卫跳到登录页）→ signedOut', async () => {
    expect(await bridgeStatus(BASE, { fetchImpl: respond(401) })).toBe('signedOut');
    const redirect = vi.fn(async () => new Response(null, { status: 302 }));
    expect(await bridgeStatus(BASE, { fetchImpl: redirect })).toBe('signedOut');
  });

  it('5xx、网络错误、超时 → unavailable', async () => {
    expect(await bridgeStatus(BASE, { fetchImpl: respond(502) })).toBe('unavailable');
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await bridgeStatus(BASE, { fetchImpl: down })).toBe('unavailable');
    const hang = vi.fn(
      (_u: string, o?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          o?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    expect(await bridgeStatus(BASE, { fetchImpl: hang, timeoutMs: 20 })).toBe('unavailable');
  });
});

describe('createBridgeClient', () => {
  it('所有请求都带 credentials: include', async () => {
    const f = respond(201, { thread: 't1', message_id: 2, job_id: 3, agent_online: true });
    const client = createBridgeClient(BASE, f);
    await client.send('你好', {
      scope: 'pagepilot',
      newThread: true,
      options: { instructions: 'x' },
    });
    const [url, opts] = f.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE}/send`);
    expect(opts?.credentials).toBe('include');
    expect(JSON.parse(String(opts?.body))).toMatchObject({
      text: '你好',
      scope: 'pagepilot',
      new_thread: true,
      options: { instructions: 'x' },
    });
  });

  it('normalizeBridgeUrl 去掉末尾斜杠', () => {
    expect(normalizeBridgeUrl(`${BASE}//`)).toBe(BASE);
  });
});
