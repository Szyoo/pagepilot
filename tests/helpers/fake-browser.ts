/**
 * `wxt/browser` 的内存实现，只覆盖 storage.local / storage.session / alarms / runtime.getManifest。
 *
 * 用法（vi.mock 会被提升，所以在测试文件里写）：
 *   vi.mock('wxt/browser', async () => (await import('../helpers/fake-browser')).browserModule);
 */

class MemoryArea {
  data = new Map<string, unknown>();

  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    const names = keys == null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of names) {
      if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }

  async clear(): Promise<void> {
    this.data.clear();
  }
}

export const fakeBrowser = {
  storage: { local: new MemoryArea(), session: new MemoryArea() },
  alarms: {
    created: [] as { name: string; info: unknown }[],
    async create(name: string, info: unknown) {
      fakeBrowser.alarms.created.push({ name, info });
    },
    async clear(_name: string) {
      return true;
    },
  },
  runtime: {
    getManifest: () => ({ version: '0.0.0-test' }),
  },
};

export function resetFakeBrowser(): void {
  fakeBrowser.storage.local.data.clear();
  fakeBrowser.storage.session.data.clear();
  fakeBrowser.alarms.created.length = 0;
}

export const browserModule = { browser: fakeBrowser };
