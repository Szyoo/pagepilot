import { test } from './fixtures';
import { captchaRule, slowRule } from './rules';

test('断线重连后按 lastSeq 补发增量，删除规则同步生效', async ({ backend, ext }) => {
  await ext.signIn();
  backend.pushRule(captchaRule(backend.origin()));
  await ext.waitForState((st) => st.rules.length === 1, '收到第 1 条规则');

  backend.dropConnections();
  const seq = backend.pushRule(slowRule(backend.origin(), 1000)); // 断线期间下发
  await backend.received.waitFor('hello', (m) => m.lastSeq === seq - 1);
  await ext.waitForState((st) => st.rules.length === 2, '重连后补发第 2 条规则');

  backend.removeRule('e2e-captcha');
  await ext.waitForState(
    (st) => st.rules.length === 1 && st.rules[0]?.id === 'e2e-slow',
    '删除规则已同步',
  );
});
