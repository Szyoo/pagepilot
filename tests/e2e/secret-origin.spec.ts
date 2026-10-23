import { expect, fakeValue, test } from './fixtures';
import { loginRule } from './rules';

test('凭据只允许 127.0.0.1，在 localhost 页面上运行时拒绝填写', async ({
  context,
  backend,
  ext,
}) => {
  const name = fakeValue('user');
  const pass = fakeValue('pass');

  await ext.signIn();
  backend.pushRule(loginRule([backend.origin('127.0.0.1'), backend.origin('localhost')]));
  await ext.waitForState((st) => st.rules.some((r) => r.id === 'e2e-login'), '收到规则');
  await ext.rpc('rule.approve', { ruleId: 'e2e-login' });
  await ext.saveVault({
    profile: { name },
    secret: { pass },
    secretOrigins: { pass: ['127.0.0.1'] },
  });

  const page = await context.newPage();
  await page.goto(`${backend.origin('localhost')}/pages/login.html`);
  const tabId = await ext.tabIdOf(page);

  const { runId } = await ext.rpc('run.start', { ruleId: 'e2e-login', tabId });
  const run = await ext.waitForRun(
    runId,
    (r) => r.status !== 'running' && r.status !== 'handoff',
    '运行结束',
  );
  expect(run.status).toBe('failed');
  expect(run.errorCode).toBe('SECRET_ORIGIN_DENIED');

  await expect(page.locator('#pass')).toHaveValue('');
  expect(page.url()).toContain('/pages/login.html');
  expect(backend.loginSubmissions).toHaveLength(0);

  const report = await backend.received.waitFor('runReport', (m) => m.runId === runId);
  expect(report.status).toBe('failed');
  const steps = report.steps as { stepId: string; status: string; errorCode?: string }[];
  expect(steps.at(-1)).toMatchObject({
    stepId: 's2',
    status: 'failed',
    errorCode: 'SECRET_ORIGIN_DENIED',
  });
  const uplinks = JSON.stringify(backend.received.all);
  expect(uplinks.includes(name), '上行消息不含个人信息').toBe(false);
  expect(uplinks.includes(pass), '上行消息不含凭据').toBe(false);
});
