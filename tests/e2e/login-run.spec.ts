import { expect, fakeValue, test } from './fixtures';
import { loginRule } from './rules';

test('登录后收到规则，确认并运行，表单被填好且上报不含本地数据', async ({
  context,
  backend,
  ext,
}) => {
  const name = fakeValue('user');
  const pass = fakeValue('pass');

  await ext.signIn();

  const seq = backend.pushRule(loginRule([backend.origin()]));
  let s = await ext.waitForState((st) => st.rules.some((r) => r.id === 'e2e-login'), '收到规则');
  expect(s.rules.find((r) => r.id === 'e2e-login')?.approved).toBe(false);
  await expect.poll(() => backend.acks.includes(seq), { message: '扩展确认了下行序号' }).toBe(true);

  // 未确认的规则不能运行
  const page = await context.newPage();
  await page.goto(`${backend.origin()}/pages/login.html`);
  const tabId = await ext.tabIdOf(page);
  await expect(ext.rpc('run.start', { ruleId: 'e2e-login', tabId })).rejects.toThrow('请先确认');

  await ext.rpc('rule.approve', { ruleId: 'e2e-login' });
  s = await ext.state();
  expect(s.rules.find((r) => r.id === 'e2e-login')?.approved).toBe(true);

  await ext.saveVault({
    profile: { name },
    secret: { pass },
    secretOrigins: { pass: ['127.0.0.1'] },
  });

  const { runId } = await ext.rpc('run.start', { ruleId: 'e2e-login', tabId });
  const run = await ext.waitForRun(
    runId,
    (r) => r.status !== 'running' && r.status !== 'handoff',
    '运行结束',
  );
  expect(run.status).toBe('succeeded');

  // 表单由扩展填写后提交到假后台；只比较是否一致，不输出值
  await expect(page.getByTestId('user-menu')).toBeVisible();
  expect(backend.loginSubmissions).toHaveLength(1);
  const submitted = backend.loginSubmissions[0] ?? {};
  expect(submitted.user === name, '用户名与个人信息一致').toBe(true);
  expect(submitted.pass === pass, '密码与凭据一致').toBe(true);

  const report = await backend.received.waitFor('runReport', (m) => m.runId === runId);
  expect(report.status).toBe('succeeded');
  expect(report.ruleId).toBe('e2e-login');
  expect(report.inputMode).toBe('synthetic');
  expect((report.steps as { stepId: string }[]).map((x) => x.stepId)).toEqual([
    's1',
    's2',
    's3',
    's4',
  ]);
  // 所有上行消息都不包含本地数据
  const uplinks = JSON.stringify(backend.received.all);
  expect(uplinks.includes(name), '上行消息不含个人信息').toBe(false);
  expect(uplinks.includes(pass), '上行消息不含凭据').toBe(false);
});
