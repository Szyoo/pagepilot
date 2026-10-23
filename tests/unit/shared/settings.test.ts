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
      clientId: 'pagepilot',
      transport: 'websocket',
      pollIntervalSec: 60,
      sound: false,
      minRepeatIntervalMs: 3000,
      sites: {},
    });
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
  });

  it('环境变量提供默认后台地址，存储值优先', async () => {
    vi.stubEnv('VITE_DEFAULT_BACKEND_URL', 'https://env.example.com');
    expect((await loadSettings()).backendUrl).toBe('https://env.example.com');
    await saveSettings({ backendUrl: 'https://own.example.com' });
    expect((await loadSettings()).backendUrl).toBe('https://own.example.com');
  });

  it('按站点覆盖的输入方式被校验', () => {
    expect(settingsSchema.safeParse({ sites: { 'a.com': { inputMode: 'bogus' } } }).success).toBe(
      false,
    );
  });
});
