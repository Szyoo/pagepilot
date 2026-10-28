/// <reference types="chrome" />
// 传给 page.evaluate 的函数在扩展页面里执行，可以使用 chrome.* API

import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import type { FakeBackend } from './fake-backend';
import { FakeBridge } from './fake-bridge';
import { test as base, type ExtensionHelper, expect, fakeValue } from './fixtures';
import { stuckRule } from './rules';

const test = base.extend<{ bridge: FakeBridge }>({
  bridge: async ({ backend }, use) => {
    // 假 bridge 只认假后台（门户）下发的会话 cookie；cookie 不区分端口，浏览器会一并带上
    const bridge = await FakeBridge.start({ authorize: (req) => backend.isSignedIn(req) });
    await use(bridge);
    await bridge.close();
  },
});

/** 在 step1.html 上运行规则直到第 2 步失败暂停；页面上事先填好一个随机假值 */
async function stuckWithFilledInput(page: Page, ext: ExtensionHelper, backend: FakeBackend) {
  await page.goto(`${backend.origin()}/pages/step1.html`);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'memo';
    input.setAttribute('aria-label', '备注');
    document.body.append(input);
  });
  const typed = fakeValue('typed');
  await page.locator('#memo').fill(typed);
  const tabId = await ext.tabIdOf(page);
  const { runId } = await ext.rpc('run.start', { ruleId: 'e2e-stuck', tabId });
  await ext.waitForRun(runId, (r) => !!r.stuck, '第 2 步失败后暂停');
  return { typed, runId };
}

/** 侧边栏页面开在单独的弹出窗口里，运行所在的标签页仍是原窗口的活动标签页 */
async function openSidepanel(context: BrowserContext, ext: ExtensionHelper): Promise<Page> {
  const opened = context.waitForEvent('page', (p) => p.url().endsWith('/sidepanel.html'));
  await ext.page.evaluate(async () => {
    await chrome.windows.create({
      url: chrome.runtime.getURL('sidepanel.html'),
      type: 'popup',
      width: 420,
      height: 860,
    });
  });
  const panel = await opened;
  await panel.setViewportSize({ width: 400, height: 800 });
  await panel.waitForLoadState();
  return panel;
}

async function openAssist(panel: Page) {
  await panel.getByRole('button', { name: '请 AI 看看' }).click();
  const assist = panel.getByRole('region', { name: '请 AI 看看' });
  await expect(assist).toBeVisible();
  return assist;
}

test.describe('卡住时「请 AI 看看」', () => {
  test.beforeEach(async ({ backend, bridge, ext }) => {
    // 不在设置里填 bridge 地址：扩展从后台 /api/ai/status 自动获取
    backend.aiStatus = { available: true, bridgeUrl: bridge.url, scope: 'pagepilot' };
    await ext.signIn();
    backend.pushRule(stuckRule(backend.origin()));
    await ext.waitForState((st) => st.rules.some((r) => r.id === 'e2e-stuck'), '收到规则');
    await ext.rpc('rule.approve', { ruleId: 'e2e-stuck' });
    await ext.saveVault({});
  });

  test('不附截图：首条消息带失败步骤与系统提示、不含输入值；显示回复后可以追问', async ({
    context,
    backend,
    bridge,
    ext,
  }) => {
    const page = await context.newPage();
    const { typed } = await stuckWithFilledInput(page, ext, backend);
    const panel = await openSidepanel(context, ext);
    const assist = await openAssist(panel);

    const shot = assist.getByRole('checkbox', { name: /附上当前页面截图/ });
    await expect(shot).not.toBeChecked();
    await assist.getByRole('button', { name: '开始分析' }).click();

    const first = await bridge.waitForSend(1);
    expect(first).toMatchObject({ path: '/send', scope: 'pagepilot', newThread: true, files: [] });
    expect(first.text).toContain('「测试失败暂停」');
    expect(first.text).toContain('第 2 步「点不存在的按钮」（点击）失败');
    expect(first.text).toContain('TARGET_NOT_FOUND');
    expect(first.text).toContain(`地址：${backend.origin()}/pages/step1.html`);
    expect(first.text).toContain('- input（textbox）「备注」');
    expect(first.text).toContain('- button「开始」');
    expect(first.text).not.toContain(typed);
    expect(String(first.options?.instructions)).toContain('PagePilot 是一个 Chrome 网页自动化扩展');
    expect(bridge.uploads).toHaveLength(0);

    // 组件显示假 bridge 的回复
    await expect(assist.getByText('看起来页面上找不到要点的按钮')).toBeVisible();
    await expect(assist.getByText('已发送：规则名称')).toBeVisible();

    // 需要看界面时：PAGEPILOT_E2E_SHOT=1 把截图存到系统临时目录
    // 回复结束后发送按钮恢复成「发送」
    await expect(assist.locator('.bridge-send')).toHaveAttribute('title', '发送');
    if (process.env.PAGEPILOT_E2E_SHOT) {
      await panel.screenshot({ path: path.join(tmpdir(), 'pagepilot-assist-panel.png') });
      await panel.emulateMedia({ colorScheme: 'dark' });
      await panel.screenshot({ path: path.join(tmpdir(), 'pagepilot-assist-panel-dark.png') });
      await panel.emulateMedia({ colorScheme: 'light' });
    }

    // 用户在组件里追问
    const input = assist.locator('.bridge-input');
    await input.fill('那我现在该点哪个？');
    await assist.locator('.bridge-send').click();
    const second = await bridge.waitForSend(2);
    expect(second).toMatchObject({
      path: `/threads/${first.thread}/messages`,
      text: '那我现在该点哪个？',
      options: null,
    });
    await expect(assist.getByText('收到第 2 条。')).toBeVisible();

    // 页面概要只交给侧边栏，不上报后台
    expect(backend.received.of('capture')).toHaveLength(0);

    // 返回后面板关闭，卡住的运行仍在等待
    await assist.getByRole('button', { name: '← 返回' }).click();
    await expect(assist).toBeHidden();
    await expect(panel.getByRole('button', { name: '重试这一步' })).toBeVisible();
  });

  test('勾选截图：/files 收到一张图片，首条消息带上它', async ({
    context,
    backend,
    bridge,
    ext,
  }) => {
    const page = await context.newPage();
    await stuckWithFilledInput(page, ext, backend);
    const panel = await openSidepanel(context, ext);
    await page.bringToFront();
    const assist = await openAssist(panel);

    await assist.getByRole('checkbox', { name: /附上当前页面截图/ }).check();
    await assist.getByRole('button', { name: '开始分析' }).click();

    const first = await bridge.waitForSend(1);
    expect(bridge.uploads).toHaveLength(1);
    const [upload] = bridge.uploads;
    expect(upload?.mime).toBe('image/jpeg');
    // JPEG 文件头
    expect(upload?.bytes.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(first.files).toEqual([upload?.id]);
    expect(first.text).toContain('附件是当前页面可见区域的截图');
    await expect(assist.getByText('、页面截图')).toBeVisible();
  });

  test('门户会话失效（bridge 返回 401）：提示先登录门户，不发送任何内容', async ({
    context,
    backend,
    bridge,
    ext,
  }) => {
    const page = await context.newPage();
    await stuckWithFilledInput(page, ext, backend);
    // 地址已在后台缓存里（5 分钟）：会话失效后面板仍能找到 bridge，由 bridge 返回 401
    await ext.rpc('ai.bridge');
    backend.expireSessions();
    const panel = await openSidepanel(context, ext);
    const assist = await openAssist(panel);

    await expect(assist.getByText('请先在普通网页里登录门户')).toBeVisible();
    await expect(assist.getByRole('button', { name: '打开门户' })).toBeVisible();
    await assist.getByRole('button', { name: '开始分析' }).click();
    await expect(assist.getByText('请先在普通网页里登录门户')).toBeVisible();
    expect(bridge.rejected).toBeGreaterThan(0);
    expect(bridge.sends).toHaveLength(0);
    expect(bridge.uploads).toHaveLength(0);
  });

  test('后台下发的地址：扩展不需要在设置里填写，面板按后台地址连接', async ({ ext, bridge }) => {
    const info = await ext.rpc('ai.bridge');
    expect(info).toMatchObject({
      bridgeUrl: bridge.url,
      scope: 'pagepilot',
      available: true,
      source: 'backend',
    });
  });
});

test.describe('后台没有接入 AI 服务', () => {
  for (const [name, status] of [
    ['available 为 false 且没有地址', { available: false, bridgeUrl: null }],
    ['没有这个接口（404）', null],
  ] as const) {
    test(`${name}：提示后台还没有接入，不能开始分析`, async ({ context, backend, bridge, ext }) => {
      backend.aiStatus = status;
      await ext.signIn();
      backend.pushRule(stuckRule(backend.origin()));
      await ext.waitForState((st) => st.rules.some((r) => r.id === 'e2e-stuck'), '收到规则');
      await ext.rpc('rule.approve', { ruleId: 'e2e-stuck' });
      await ext.saveVault({});
      const page = await context.newPage();
      await stuckWithFilledInput(page, ext, backend);
      const panel = await openSidepanel(context, ext);
      const assist = await openAssist(panel);

      await expect(assist.getByText('后台还没有接入 AI 服务')).toBeVisible();
      await expect(assist.getByRole('button', { name: '开始分析' })).toBeDisabled();
      expect(bridge.requests).toHaveLength(0);
    });
  }
});
