/// <reference types="chrome" />
// 传给 page.evaluate 的函数在扩展页面里执行，可以使用 chrome.* API

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type BrowserContext,
  test as base,
  chromium,
  expect,
  type Page,
  type Worker,
} from '@playwright/test';
import type { BgState, RpcMethod, RpcMethods, RunView } from '../../src/shared/rpc';
import { FakeBackend, type FakeBackendOptions } from './fake-backend';

/** e2e 构建产物，见 global-setup.ts */
export const EXTENSION_DIR = path.resolve('.output/e2e/chrome-mv3');
/** 声明了调试权限的 e2e 构建，用 test.use({ extensionDir: TRUSTED_EXTENSION_DIR }) 选用 */
export const TRUSTED_EXTENSION_DIR = path.resolve('.output/e2e-trusted/chrome-mv3');

/** 随机生成的假值，用作测试凭据 */
export const fakeValue = (prefix: string) => `${prefix}-${randomBytes(9).toString('base64url')}`;

export const css = (value: string) => ({ strategies: [{ kind: 'css' as const, value }] });

export interface ExtensionHelper {
  id: string;
  /** 打开在标签页里的扩展页面，用于调用 RPC 与读写扩展存储 */
  page: Page;
  rpc<M extends RpcMethod>(
    method: M,
    ...params: RpcMethods[M]['params'] extends undefined ? [] : [RpcMethods[M]['params']]
  ): Promise<RpcMethods[M]['result']>;
  state(): Promise<BgState>;
  /** 轮询后台状态直到满足条件 */
  waitForState(
    pred: (s: BgState) => boolean,
    message: string,
    timeoutMs?: number,
  ): Promise<BgState>;
  waitForRun(
    runId: string,
    pred: (r: RunView) => boolean,
    message: string,
    timeoutMs?: number,
  ): Promise<RunView>;
  /** 写入设置（backendUrl 指向假后台，可用参数覆盖），不登录 */
  configure(settings?: Record<string, unknown>): Promise<void>;
  /**
   * 写入设置后用假后台的测试账号走 RPC `auth.login` 登录，等待实时通道连上假后台。
   * 默认还等待 hello；轮询通道不发 hello，需传 waitHello: false
   */
  signIn(settings?: Record<string, unknown>, opts?: { waitHello?: boolean }): Promise<void>;
  /** 写入个人信息与凭据（需要已登录，先调用 signIn） */
  saveVault(data: {
    profile?: Record<string, string>;
    secret?: Record<string, string>;
    secretOrigins?: Record<string, string[]>;
  }): Promise<void>;
  tabIdOf(page: Page): Promise<number>;
  /** 当前的后台 service worker */
  worker(): Promise<Worker>;
  /** 终止后台 service worker（CDP Target.closeTarget） */
  stopWorker(): Promise<void>;
}

interface Options {
  /** 加载的扩展目录 */
  extensionDir: string;
  /** 假后台的选项，用 test.use({ backendOptions: {...} }) 覆盖 */
  backendOptions: FakeBackendOptions;
}

interface Fixtures {
  backend: FakeBackend;
  context: BrowserContext;
  ext: ExtensionHelper;
}

export const test = base.extend<Fixtures & Options>({
  extensionDir: [EXTENSION_DIR, { option: true }],

  backendOptions: [{}, { option: true }],

  backend: async ({ backendOptions }, use) => {
    const backend = await FakeBackend.start(backendOptions);
    await use(backend);
    await backend.close();
  },

  context: async ({ extensionDir }, use) => {
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'pagepilot-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      // 完整版 Chromium 的新无头模式支持扩展；PWDEBUG / HEADED=1 时显示界面
      channel: 'chromium',
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    await use(context);
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  },

  ext: async ({ context, backend }, use) => {
    const firstWorker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(firstWorker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/offscreen.html`);

    const rpc: ExtensionHelper['rpc'] = async (method, ...params) => {
      const res = await page.evaluate(
        ([m, p]) => chrome.runtime.sendMessage({ type: 'rpc', method: m, params: p }),
        [method, params[0]] as const,
      );
      const r = res as { ok: true; result: never } | { ok: false; error: string } | undefined;
      if (!r) throw new Error(`RPC ${method}：后台未响应`);
      if (!r.ok) throw new Error(`RPC ${method} 失败：${r.error}`);
      return r.result;
    };

    const state = () => rpc('state.get');

    const waitForState: ExtensionHelper['waitForState'] = async (pred, message, timeoutMs) => {
      let last: BgState | undefined;
      await expect
        .poll(
          async () => {
            last = await state();
            return pred(last);
          },
          { message, timeout: timeoutMs ?? 20_000, intervals: [100, 200, 250] },
        )
        .toBe(true);
      return last as BgState;
    };

    const waitForRun: ExtensionHelper['waitForRun'] = async (runId, pred, message, timeoutMs) => {
      const s = await waitForState(
        (st) => {
          const r = st.runs.find((x) => x.runId === runId);
          return !!r && pred(r);
        },
        message,
        timeoutMs,
      );
      return s.runs.find((x) => x.runId === runId) as RunView;
    };

    const helper: ExtensionHelper = {
      id,
      page,
      rpc,
      state,
      waitForState,
      waitForRun,

      async configure(settings = {}) {
        // 门户地址省略时与后台地址相同（假后台同时充当门户）
        await page.evaluate(
          async ({ backendUrl, settings }) => {
            await chrome.storage.local.set({
              settings: {
                backendUrl,
                transport: 'websocket',
                minRepeatIntervalMs: 1000,
                ...settings,
              },
            });
          },
          { backendUrl: backend.url, settings },
        );
      },

      async signIn(settings = {}, opts = {}) {
        // 网站访问权限由 e2e 构建的 host_permissions 提供（见 wxt.config.ts），无需弹窗授权
        await helper.configure(settings);
        await rpc('auth.login', {
          username: backend.account.username,
          password: backend.account.password,
        });
        await waitForState(
          (s) => s.auth.status === 'signedIn' && s.connection.status === 'connected',
          '实时通道连上假后台',
        );
        if (opts.waitHello !== false) await backend.received.waitFor('hello');
      },

      async saveVault(data) {
        await rpc('vault.save', {
          profile: data.profile ?? {},
          secret: data.secret ?? {},
          secretOrigins: data.secretOrigins ?? {},
        });
      },

      async tabIdOf(target) {
        const url = target.url();
        const id = await page.evaluate(async (u) => {
          const tabs = await chrome.tabs.query({});
          return tabs.find((t) => t.url === u)?.id;
        }, url);
        if (id === undefined) throw new Error(`找不到标签页：${url}`);
        return id;
      },

      async worker() {
        const sw = context.serviceWorkers().at(-1);
        return sw ?? context.waitForEvent('serviceworker');
      },

      async stopWorker() {
        const browser = context.browser();
        if (!browser) throw new Error('无法取得浏览器实例');
        const cdp = await browser.newBrowserCDPSession();
        try {
          const { targetInfos } = await cdp.send('Target.getTargets');
          const sw = targetInfos.find(
            (t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${id}/`),
          );
          if (!sw) throw new Error('找不到扩展的 service worker');
          await cdp.send('Target.closeTarget', { targetId: sw.targetId });
        } finally {
          await cdp.detach();
        }
      },
    };
    await use(helper);
  },
});

export { expect };
