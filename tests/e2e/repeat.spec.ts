import { expect, test } from './fixtures';
import { bookingRule } from './rules';

test('repeat 刷新直到出现名额，间隔不低于设置的下限', async ({ context, backend, ext }) => {
  const minInterval = 1000;
  await ext.signIn({ minRepeatIntervalMs: minInterval });
  // 规则要求的间隔低于下限，实际应按下限执行
  backend.pushRule(bookingRule(backend.origin(), 200));
  await ext.waitForState((st) => st.rules.some((r) => r.id === 'e2e-booking'), '收到规则');
  await ext.rpc('rule.approve', { ruleId: 'e2e-booking' });
  await ext.saveVault({});

  const page = await context.newPage();
  await page.goto(`${backend.origin()}/pages/booking.html?availableAfter=3`);
  const tabId = await ext.tabIdOf(page);

  const { runId } = await ext.rpc('run.start', { ruleId: 'e2e-booking', tabId });
  await ext.waitForRun(runId, (r) => r.repeat?.attempt === 2, '进入第 2 轮');
  const run = await ext.waitForRun(runId, (r) => r.status === 'succeeded', '出现名额后成功');
  expect(run.errorCode).toBeUndefined();
  await expect(page.locator('#picked')).toHaveText('已选择 10:00');

  // 第 1 次加载由测试打开，之后每轮刷新一次，第 3 次加载出现名额
  expect(backend.bookingLoads).toHaveLength(3);
  const [l1 = 0, l2 = 0, l3 = 0] = backend.bookingLoads;
  expect(l2 - l1).toBeGreaterThanOrEqual(minInterval);
  expect(l3 - l2).toBeGreaterThanOrEqual(minInterval);

  const report = await backend.received.waitFor('runReport', (m) => m.runId === runId);
  expect(report.status).toBe('succeeded');
  // 每轮执行一次 s1a，共 3 轮
  const steps = (report.steps as { stepId: string }[]).map((s) => s.stepId);
  expect(steps.filter((s) => s === 's1a')).toHaveLength(3);
});
