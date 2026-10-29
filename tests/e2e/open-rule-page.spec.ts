/// <reference types="chrome" />
// 传给 page.evaluate 的函数在扩展页面里执行，可以使用 chrome.* API

import type { BrowserContext, Page } from '@playwright/test';
import { css, type ExtensionHelper, expect, test } from './fixtures';

/** 侧边栏页面开在单独的弹出窗口里 */
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

const pagesOn = (context: BrowserContext, url: string) =>
  context.pages().filter((p) => p.url() === url).length;

test('规则页签「打开页面」：没有打开时新开规则的页面，已经打开时切过去不再新开', async ({
  backend,
  context,
  ext,
}) => {
  await ext.signIn();
  const entry = `${backend.origin()}/pages/step1.html`;
  backend.pushRule({
    id: 'e2e-entry',
    name: '测试打开页面',
    version: 1,
    match: { urls: [`${backend.origin()}/pages/step*`] },
    steps: [
      { id: 's1', type: 'open', url: entry },
      { id: 's2', type: 'click', target: css('#start') },
    ],
  });
  await ext.waitForState((s) => s.rules.some((r) => r.id === 'e2e-entry'), '收到规则');

  const panel = await openSidepanel(context, ext);
  await panel.getByRole('tab', { name: '规则' }).click();
  const card = panel.getByRole('article', { name: '测试打开页面' });

  const opened = context.waitForEvent('page', (p) => p.url() === entry);
  await card.getByRole('button', { name: '打开页面' }).click();
  await opened;
  expect(pagesOn(context, entry)).toBe(1);

  // 先切走，再点一次：切回已经打开的那个标签页，不再新开
  const other = await context.newPage();
  await other.goto(`${backend.origin()}/pages/captcha.html`);
  await other.bringToFront();
  await card.getByRole('button', { name: '打开页面' }).click();
  await expect
    .poll(() =>
      ext.page.evaluate(
        async (u) => (await chrome.tabs.query({ url: u }))[0]?.active ?? false,
        entry,
      ),
    )
    .toBe(true);
  expect(pagesOn(context, entry)).toBe(1);
});
