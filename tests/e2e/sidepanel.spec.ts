/// <reference types="chrome" />
// 传给 page.evaluate 的函数在扩展页面里执行，可以使用 chrome.* API

import { expect, test } from './fixtures';

test('点扩展图标直接打开侧边栏：没有弹窗，openPanelOnActionClick 已开启', async ({ ext }) => {
  const manifest = await ext.page.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.action?.default_popup).toBeUndefined();
  expect(manifest.side_panel).toEqual({ default_path: 'sidepanel.html' });
  await expect
    .poll(() => ext.page.evaluate(() => chrome.sidePanel.getPanelBehavior()))
    .toEqual({ openPanelOnActionClick: true });
});
