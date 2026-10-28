import type { RawRule } from './fake-backend';
import { css, expect, test } from './fixtures';

const ruleIdOf = (force: boolean) => (force ? 'e2e-open-force' : 'e2e-open');

/** 打开第一步页面、点「开始」：已经停在这页时 open 不应重新加载页面 */
function openRule(origin: string, force: boolean): RawRule {
  return {
    id: ruleIdOf(force),
    name: force ? '测试强制重新打开' : '测试已在页面不重新打开',
    version: 1,
    match: { urls: [`${origin}/pages/step*`] },
    steps: [
      {
        id: 's1',
        type: 'open',
        url: `${origin}/pages/step1.html?from=rule`,
        ...(force ? { force: true } : {}),
      },
      { id: 's2', type: 'click', target: css('#start') },
    ],
  };
}

for (const force of [false, true]) {
  const title = force
    ? 'open 加 force 时总是重新打开页面'
    : '已停在同一页面时 open 不重新打开，直接进入下一步';

  test(title, async ({ backend, context, ext }) => {
    await ext.signIn();
    const ruleId = ruleIdOf(force);
    backend.pushRule(openRule(backend.origin(), force));
    await ext.waitForState((s) => s.rules.some((r) => r.id === ruleId), '收到规则');
    await ext.rpc('rule.approve', { ruleId });
    await ext.saveVault({});

    const page = await context.newPage();
    // 查询参数与规则里的不同：只比较网站与路径
    await page.goto(`${backend.origin()}/pages/step1.html?from=user`);
    await page.evaluate(() => {
      (window as unknown as { __marker: string }).__marker = '运行前留下的标记';
    });

    const tabId = await ext.tabIdOf(page);
    const { runId } = await ext.rpc('run.start', { ruleId, tabId });
    await ext.waitForRun(runId, (r) => r.status === 'succeeded', '运行成功');
    await expect(page.locator('#status')).toHaveText('已开始');

    const marker = await page.evaluate(() => (window as unknown as { __marker?: string }).__marker);
    if (force) {
      // 重新打开后页面是新的，标记没了，地址换成了规则里的
      expect(marker).toBeUndefined();
      expect(page.url()).toContain('from=rule');
    } else {
      expect(marker).toBe('运行前留下的标记');
      expect(page.url()).toContain('from=user');
    }
  });
}
