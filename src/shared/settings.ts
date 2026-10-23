import { browser } from 'wxt/browser';
import { z } from 'zod';

export const settingsSchema = z.object({
  /** 后台地址，API 路径见 docs/protocol.md */
  backendUrl: z.url().optional(),
  /** 门户授权服务地址，为空时与后台地址相同 */
  authUrl: z.url().optional(),
  clientId: z.string().default('pagepilot'),
  /** 实时通道优先级 */
  transport: z.enum(['websocket', 'sse', 'poll']).default('websocket'),
  pollIntervalSec: z.number().int().min(30).default(60),
  /** 提示音总开关，默认关闭；规则无法绕过 */
  sound: z.boolean().default(false),
  /** repeat 两轮之间的最小间隔，规则无法低于该值 */
  minRepeatIntervalMs: z.number().int().min(1000).default(3000),
  /** 按站点覆盖输入方式，键为主机名 */
  sites: z
    .record(z.string(), z.object({ inputMode: z.enum(['auto', 'trusted', 'synthetic']) }))
    .default({}),
});

export type Settings = z.infer<typeof settingsSchema>;

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = (await browser.storage.local.get(KEY))[KEY] as object | undefined;
  const envBackend = import.meta.env.VITE_DEFAULT_BACKEND_URL as string | undefined;
  const parsed = settingsSchema.safeParse({
    ...(envBackend ? { backendUrl: envBackend } : {}),
    ...(stored ?? {}),
  });
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = settingsSchema.parse({ ...(await loadSettings()), ...patch });
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export const SETTINGS_KEY = KEY;
