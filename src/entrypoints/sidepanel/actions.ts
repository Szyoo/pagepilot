import { browser } from 'wxt/browser';
import { originPatternOf, samePage } from '../../shared/glob';
import { type RuleView, rpc } from '../../shared/rpc';

/** 运行一条规则：先申请网站访问权限（需用户手势，须在点击处理函数里直接调用），再启动 */
export async function startRule(
  rule: Pick<RuleView, 'id' | 'matchUrls' | 'inputMode'>,
  tabId: number,
): Promise<void> {
  const origins = [
    ...new Set(rule.matchUrls.map(originPatternOf).filter((o): o is string => o !== null)),
  ];
  const request: { origins: string[]; permissions?: string[] } = { origins };
  if (rule.inputMode === 'trusted') request.permissions = ['debugger'];
  const granted = await browser.permissions.request(request as never);
  if (!granted) throw new Error('未授予所需权限，无法运行');
  await rpc('run.start', { ruleId: rule.id, tabId });
}

/**
 * 进入规则所属的页面：优先切到运行所在的标签页；否则切到已经打开着这个页面的标签页；
 * 都没有时新开一个
 */
export async function openRulePage(entryUrl: string | undefined, runTabId?: number): Promise<void> {
  const tab =
    (runTabId !== undefined
      ? await browser.tabs.get(runTabId).catch(() => undefined)
      : undefined) ??
    (entryUrl
      ? (await browser.tabs.query({})).find((t) => t.url && samePage(t.url, entryUrl))
      : undefined);
  if (tab?.id !== undefined) {
    await browser.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
    return;
  }
  if (!entryUrl) throw new Error('这条规则没有可以直接打开的页面地址');
  await browser.tabs.create({ url: entryUrl });
}

export async function openUrl(url: string): Promise<void> {
  await browser.tabs.create({ url });
}
