// 设计包初始化：右上角工具位（明暗 / 外观，SSO 时再加应用切换器与账户菜单）+ 背景主题。
// "@szyyw/design/" 由页面里的 import map 指到 design.szyyw.xyz/<版本>/（版本见 pagepilot_server/design.py）。
import { mountChrome } from '@szyyw/design/chrome.js';

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || '';
const portal =
  meta('pagepilot-sso') === '1' ? meta('pagepilot-portal') || 'https://szyyw.xyz' : null;

mountChrome({
  background: document.querySelector('.bg-layer'),
  cookiePrefix: 'pagepilot_',
  persist: 'localStorage',
  locale: 'zh',
  portal,
  appearance: { dotField: { note: true } },
});
