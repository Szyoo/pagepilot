import { describe, expect, it, vi } from 'vitest';
import {
  BACKEND_AI_TTL_MS,
  createBackendAiCache,
  parseBackendAi,
  pickBridge,
} from '../../../src/shared/bridge-discovery';

const SETTINGS = 'https://settings.example.com/api';
const BACKEND = 'https://bridge.example.com/api';
const BUILD = 'https://build.example.com/api';
const backendAi = { available: true, bridgeUrl: BACKEND, scope: 'ai-scope' };

describe('pickBridge 地址来源优先级', () => {
  it('设置页 > 后台 > 构建期', () => {
    expect(pickBridge({ settingsUrl: SETTINGS, buildUrl: BUILD, backend: backendAi })).toEqual({
      bridgeUrl: SETTINGS,
      scope: 'ai-scope',
      available: true,
      source: 'settings',
    });
    expect(pickBridge({ buildUrl: BUILD, backend: backendAi })).toMatchObject({
      bridgeUrl: BACKEND,
      source: 'backend',
    });
    expect(pickBridge({ buildUrl: BUILD, backend: null })).toMatchObject({
      bridgeUrl: BUILD,
      source: 'build',
    });
  });

  it('后台不可用或没有地址时落到构建期地址；都没有则为空', () => {
    const off = { available: false, bridgeUrl: null, scope: null };
    expect(pickBridge({ buildUrl: BUILD, backend: off })).toMatchObject({
      bridgeUrl: BUILD,
      available: false,
    });
    expect(pickBridge({ backend: off })).toEqual({
      bridgeUrl: null,
      scope: 'pagepilot',
      available: false,
      source: null,
    });
    expect(pickBridge({ settingsUrl: ' ', buildUrl: '', backend: null }).bridgeUrl).toBeNull();
  });

  it('不合法的地址被忽略；scope 缺省 pagepilot', () => {
    expect(pickBridge({ settingsUrl: 'ftp://x.example.com', backend: null }).bridgeUrl).toBeNull();
    expect(
      pickBridge({ backend: { available: true, bridgeUrl: BACKEND, scope: null } }).scope,
    ).toBe('pagepilot');
  });
});

describe('parseBackendAi', () => {
  it('解析字段并规范化地址', () => {
    expect(
      parseBackendAi({ available: true, model: 'm', bridgeUrl: `${BACKEND}/`, scope: ' s ' }),
    ).toEqual({ available: true, bridgeUrl: BACKEND, scope: 's' });
    expect(parseBackendAi({ available: false, bridgeUrl: null })).toEqual({
      available: false,
      bridgeUrl: null,
      scope: null,
    });
    expect(parseBackendAi('x')).toBeNull();
  });
});

describe('createBackendAiCache', () => {
  const ok = () =>
    vi.fn(async (_u: string, _o?: RequestInit) => new Response(JSON.stringify(backendAi)));

  it('请求 {后台}/api/ai/status；5 分钟内走缓存，过期后重新请求', async () => {
    const f = ok();
    let t = 1000;
    const cache = createBackendAiCache({ fetchImpl: f, now: () => t });
    expect(await cache.get('https://api.example.com/', 'u1')).toMatchObject({ bridgeUrl: BACKEND });
    expect(f.mock.calls[0]?.[0]).toBe('https://api.example.com/api/ai/status');
    t += BACKEND_AI_TTL_MS - 1;
    await cache.get('https://api.example.com', 'u1');
    expect(f).toHaveBeenCalledTimes(1);
    t += 2;
    await cache.get('https://api.example.com', 'u1');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('clear、换用户或换后台地址时重新请求', async () => {
    const f = ok();
    const cache = createBackendAiCache({ fetchImpl: f });
    await cache.get('https://api.example.com', 'u1');
    cache.clear();
    await cache.get('https://api.example.com', 'u1');
    await cache.get('https://api.example.com', 'u2');
    await cache.get('https://other.example.com', 'u2');
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('未登录或没有后台地址：不发请求；失败（异常、非 2xx、非 JSON）返回 null 且不缓存', async () => {
    const f = ok();
    const cache = createBackendAiCache({ fetchImpl: f });
    expect(await cache.get('https://api.example.com', undefined)).toBeNull();
    expect(await cache.get(undefined, 'u1')).toBeNull();
    expect(f).not.toHaveBeenCalled();

    const bad = vi
      .fn<(u: string, o?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('not json'))
      .mockResolvedValue(new Response(JSON.stringify(backendAi)));
    const c2 = createBackendAiCache({ fetchImpl: bad });
    expect(await c2.get('https://api.example.com', 'u1')).toBeNull();
    expect(await c2.get('https://api.example.com', 'u1')).toBeNull();
    expect(await c2.get('https://api.example.com', 'u1')).toBeNull();
    expect(await c2.get('https://api.example.com', 'u1')).toMatchObject({ available: true });
    expect(bad).toHaveBeenCalledTimes(4);
  });
});
