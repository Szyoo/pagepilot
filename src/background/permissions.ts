import { browser } from 'wxt/browser';
import type { Rule } from '../schema/rule';
import { originPatternOf } from '../shared/glob';

const SCRIPT_ID = 'pagepilot-content';

export function originsOf(rule: Pick<Rule, 'match'>): string[] {
  return [...new Set(rule.match.urls.map(originPatternOf).filter((o): o is string => o !== null))];
}

export async function hostPermitted(rule: Rule): Promise<boolean> {
  const origins = originsOf(rule);
  if (origins.length === 0) return false;
  return browser.permissions.contains({ origins });
}

/** 按已授予的网站权限动态注册 content script（所有 frame） */
export async function syncContentScripts(): Promise<void> {
  const { origins = [] } = await browser.permissions.getAll();
  const matches = origins.filter((o) => /^(\*|https?):\/\//.test(o));
  const registered = await browser.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (registered.length > 0) await browser.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (matches.length === 0) return;
  await browser.scripting.registerContentScripts([
    {
      id: SCRIPT_ID,
      matches,
      js: ['/page-agent.js'],
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
}
