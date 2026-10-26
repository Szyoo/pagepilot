import { browser } from 'wxt/browser';
import { originPatternOf } from '../../shared/glob';
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

export async function openUrl(url: string): Promise<void> {
  await browser.tabs.create({ url });
}
