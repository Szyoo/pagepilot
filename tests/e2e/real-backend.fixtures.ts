import { type BrowserContext, test as base, expect } from '@playwright/test';
import {
  createExtensionHelper,
  EXTENSION_DIR,
  type ExtensionHelper,
  launchExtensionContext,
} from './fixtures';
import { Gate, type GateUser, serverAvailable } from './gate';

/**
 * 扩展 ↔ 真实后台：每个测试启动一个 uvicorn 子进程（server/）与前面的假门卫（gate.ts），
 * 扩展的 backendUrl 指向门卫。没有 server/.venv 时整组跳过。
 */

export { serverAvailable };

export const SKIP_REASON =
  '未找到 server/.venv：先在 server/ 下执行 python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"，' +
  '或用 PAGEPILOT_SERVER_PYTHON 指定 Python';

interface Fixtures {
  gate: Gate;
  /** 普通用户 A（默认登录账号） */
  alice: GateUser;
  context: BrowserContext;
  ext: ExtensionHelper;
  /** 再开一个加载了扩展的浏览器（独立的 cookie 与扩展存储），用于多用户场景；测试结束自动关闭 */
  openExtension(): Promise<{ context: BrowserContext; ext: ExtensionHelper }>;
}

/** 等待后台日志里出现 hello（已收到的也算） */
async function waitHello(gate: Gate): Promise<void> {
  await expect
    .poll(() => gate.uplinks('hello').length, { message: '后台收到 hello', timeout: 20_000 })
    .toBeGreaterThan(0);
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright 夹具要求以解构形式声明依赖
  gate: async ({}, use, testInfo) => {
    const gate = await Gate.start();
    try {
      await use(gate);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        // 失败时附上后台日志，便于排查（只含消息类型与 id）
        await testInfo.attach('backend.log', { body: gate.backendLog, contentType: 'text/plain' });
      }
      await gate.close();
    }
  },

  alice: async ({ gate }, use) => {
    await use(gate.createUser('e2e-alice', 'user'));
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright 夹具要求以解构形式声明依赖
  context: async ({}, use) => {
    const { context, close } = await launchExtensionContext(EXTENSION_DIR);
    await use(context);
    await close();
  },

  ext: async ({ context, gate, alice }, use) => {
    await use(
      await createExtensionHelper(context, {
        url: gate.url,
        account: alice,
        waitHello: () => waitHello(gate),
      }),
    );
  },

  openExtension: async ({ gate, alice }, use) => {
    const opened: (() => Promise<void>)[] = [];
    await use(async () => {
      const { context, close } = await launchExtensionContext(EXTENSION_DIR);
      opened.push(close);
      const ext = await createExtensionHelper(context, {
        url: gate.url,
        account: alice,
        waitHello: () => waitHello(gate),
      });
      return { context, ext };
    });
    for (const close of opened) await close();
  },
});

export { expect };
