import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser, resetFakeBrowser } from '../../helpers/fake-browser';

vi.mock('wxt/browser', async () => (await import('../../helpers/fake-browser')).browserModule);

const { loadSettings, saveSettings, settingsSchema } = await import('../../../src/shared/settings');

beforeEach(() => {
  resetFakeBrowser();
  vi.unstubAllEnvs();
});

describe('settings', () => {
  it('没有存储时返回默认值', async () => {
    const s = await loadSettings();
    expect(s).toMatchObject({
      transport: 'sse',
      pollIntervalSec: 60,
      sound: false,
      minRepeatIntervalMs: 3000,
      sites: {},
    });
    expect(s.backendUrl).toBeUndefined();
    expect(s.portalUrl).toBeUndefined();
  });

  it('不再包含 OAuth 相关字段，旧存储里的 authUrl / clientId 被丢弃', async () => {
    await fakeBrowser.storage.local.set({
      settings: { authUrl: 'https://auth.example.com', clientId: 'old', sound: true },
    });
    const s = await loadSettings();
    expect(s.sound).toBe(true);
    expect(s).not.toHaveProperty('authUrl');
    expect(s).not.toHaveProperty('clientId');
  });

  it('saveSettings 合并补丁并持久化', async () => {
    await saveSettings({ sound: true });
    const next = await saveSettings({ transport: 'poll' });
    expect(next).toMatchObject({ sound: true, transport: 'poll' });
    expect(await loadSettings()).toEqual(next);
  });

  it('存储内容非法时回退默认值', async () => {
    await fakeBrowser.storage.local.set({ settings: { pollIntervalSec: 1 } });
    expect((await loadSettings()).pollIntervalSec).toBe(60);
  });

  it('saveSettings 拒绝非法值', async () => {
    await expect(saveSettings({ pollIntervalSec: 5 })).rejects.toThrow();
    await expect(saveSettings({ backendUrl: 'not-a-url' })).rejects.toThrow();
    await expect(saveSettings({ portalUrl: 'not-a-url' })).rejects.toThrow();
  });

  it('环境变量提供默认后台地址，存储值优先', async () => {
    vi.stubEnv('VITE_DEFAULT_BACKEND_URL', 'https://env.example.com');
    expect((await loadSettings()).backendUrl).toBe('https://env.example.com');
    await saveSettings({ backendUrl: 'https://own.example.com' });
    expect((await loadSettings()).backendUrl).toBe('https://own.example.com');
  });

  it('环境变量提供默认门户地址，存储值优先', async () => {
    vi.stubEnv('VITE_DEFAULT_PORTAL_URL', 'https://portal-env.example.com');
    expect((await loadSettings()).portalUrl).toBe('https://portal-env.example.com');
    await saveSettings({ portalUrl: 'https://portal.example.com' });
    expect((await loadSettings()).portalUrl).toBe('https://portal.example.com');
  });

  it('环境变量提供默认 AI 服务（bridge）地址，存储值优先；未配置时为空', async () => {
    expect((await loadSettings()).bridgeUrl).toBeUndefined();
    vi.stubEnv('VITE_DEFAULT_BRIDGE_URL', 'https://bridge-env.example.com/api');
    expect((await loadSettings()).bridgeUrl).toBe('https://bridge-env.example.com/api');
    await saveSettings({ bridgeUrl: 'https://bridge.example.com/api' });
    expect((await loadSettings()).bridgeUrl).toBe('https://bridge.example.com/api');
  });

  it('门户地址可单独保存，不影响后台地址', async () => {
    await saveSettings({ backendUrl: 'https://api.example.com' });
    const next = await saveSettings({ portalUrl: 'https://portal.example.com' });
    expect(next).toMatchObject({
      backendUrl: 'https://api.example.com',
      portalUrl: 'https://portal.example.com',
    });
  });

  it('按站点覆盖的输入方式被校验', () => {
    expect(settingsSchema.safeParse({ sites: { 'a.com': { inputMode: 'bogus' } } }).success).toBe(
      false,
    );
  });
});
