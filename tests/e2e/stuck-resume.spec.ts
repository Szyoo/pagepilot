import type { Page } from '@playwright/test';
import type { RunView } from '../../src/shared/rpc';
import type { FakeBackend } from './fake-backend';
import { css, type ExtensionHelper, expect, test } from './fixtures';
import { stuckRule } from './rules';

interface StepRow {
  stepId: string;
  status: string;
}

/** 在 step1.html 上运行规则，等到第 2 步失败暂停 */
async function startUntilStuck(page: Page, ext: ExtensionHelper, backend: FakeBackend) {
  await page.goto(`${backend.origin()}/pages/step1.html`);
  const tabId = await ext.tabIdOf(page);
  const { runId } = await ext.rpc('run.start', { ruleId: 'e2e-stuck', tabId });
  const run = await ext.waitForRun(runId, (r) => !!r.stuck, '第 2 步失败后暂停');
  expect(run.status).toBe('handoff');
  expect(run.needsConfirm).toBe(true);
  expect(run.stuck?.failedStepId).toBe('s2');
  expect(run.stuck?.failedIndex).toBe(1);
  expect(run.stuck?.errorCode).toBe('TARGET_NOT_FOUND');
  expect(run.stuck?.suggestedIndex).toBe(1);
  expect(run.stuck?.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
  expect(run.message).toContain('第 2 步「点不存在的按钮」失败');
  await expect(page.locator('#status')).toHaveText('已开始');
  return runId;
}

async function reportOf(backend: FakeBackend, runId: string) {
  const report = await backend.received.waitFor('runReport', (m) => m.runId === runId);
  return {
    status: report.status,
    steps: (report.steps as StepRow[]).map((s) => [s.stepId, s.status]),
  };
}

const succeeded = (r: RunView) => r.status === 'succeeded';

test.describe('步骤失败时暂停交给用户', () => {
  test.beforeEach(async ({ backend, ext }) => {
    await ext.signIn();
    backend.pushRule(stuckRule(backend.origin()));
    await ext.waitForState((st) => st.rules.some((r) => r.id === 'e2e-stuck'), '收到规则');
    await ext.rpc('rule.approve', { ruleId: 'e2e-stuck' });
    await ext.saveVault({});
  });

  test('用户手动跳到下一页后，建议位置随之更新，点「继续」从那里接着跑', async ({
    context,
    backend,
    ext,
  }) => {
    const page = await context.newPage();
    const runId = await startUntilStuck(page, ext, backend);

    await page.locator('#next').click(); // 用户手动处理
    await page.waitForURL('**/pages/step2.html');
    const run = await ext.waitForRun(
      runId,
      (r) => r.stuck?.suggestedIndex === 4,
      '建议从 #done（第 5 步）继续',
    );
    expect(run.status).toBe('handoff');

    await ext.rpc('run.resolve', { runId, action: 'continue' });
    await ext.waitForRun(runId, succeeded, '继续后成功');
    await expect(page.locator('#result')).toHaveText('已完成');

    expect(await reportOf(backend, runId)).toEqual({
      status: 'succeeded',
      steps: [
        ['s1', 'succeeded'],
        ['s2', 'handedOff'],
        ['s3', 'handedOff'],
        ['s4', 'handedOff'],
        ['s5', 'succeeded'],
        ['s6', 'succeeded'],
      ],
    });
  });

  test('retry：页面修好后重新执行失败的那一步', async ({ context, backend, ext }) => {
    const page = await context.newPage();
    const runId = await startUntilStuck(page, ext, backend);

    await page.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'missing';
      b.textContent = '补上的按钮';
      document.body.append(b);
    });
    await ext.rpc('run.resolve', { runId, action: 'retry' });
    await ext.waitForRun(runId, succeeded, '重试后成功');
    await expect(page.locator('#result')).toHaveText('已完成');

    const report = await reportOf(backend, runId);
    expect(report.status).toBe('succeeded');
    // 失败的那次保留，重试的那次追加
    expect(report.steps).toEqual([
      ['s1', 'succeeded'],
      ['s2', 'failed'],
      ['s2', 'succeeded'],
      ['s3', 'succeeded'],
      ['s4', 'succeeded'],
      ['s5', 'succeeded'],
      ['s6', 'succeeded'],
    ]);
  });

  test('skip：失败的那一步记为跳过，从下一步继续', async ({ context, backend, ext }) => {
    const page = await context.newPage();
    const runId = await startUntilStuck(page, ext, backend);

    await ext.rpc('run.resolve', { runId, action: 'skip' });
    await ext.waitForRun(runId, succeeded, '跳过后成功');
    await expect(page.locator('#result')).toHaveText('已完成');

    const report = await reportOf(backend, runId);
    expect(report.steps).toEqual([
      ['s1', 'succeeded'],
      ['s2', 'skipped'],
      ['s3', 'succeeded'],
      ['s4', 'succeeded'],
      ['s5', 'succeeded'],
      ['s6', 'succeeded'],
    ]);
  });

  test('goto：用户手动做完几步后，从指定的步骤继续', async ({ context, backend, ext }) => {
    const page = await context.newPage();
    const runId = await startUntilStuck(page, ext, backend);

    await page.locator('#next').click();
    await page.waitForURL('**/pages/step2.html');
    await page.locator('#done').click(); // 用户连 #done 也点了
    await ext.rpc('run.resolve', { runId, action: 'goto', index: 5 });
    await ext.waitForRun(runId, succeeded, '从断言继续并成功');

    const report = await reportOf(backend, runId);
    expect(report.steps).toEqual([
      ['s1', 'succeeded'],
      ['s2', 'handedOff'],
      ['s3', 'handedOff'],
      ['s4', 'handedOff'],
      ['s5', 'handedOff'],
      ['s6', 'succeeded'],
    ]);
  });

  test('goto 超出范围时报错，运行仍在等待', async ({ context, backend, ext }) => {
    const page = await context.newPage();
    const runId = await startUntilStuck(page, ext, backend);
    await expect(ext.rpc('run.resolve', { runId, action: 'goto', index: 7 })).rejects.toThrow(
      '超出范围',
    );
    const st = await ext.state();
    expect(st.runs.find((r) => r.runId === runId)?.stuck?.failedStepId).toBe('s2');
    await ext.rpc('run.abort', { runId });
    await ext.waitForRun(runId, (r) => r.status === 'aborted', '中止');
  });

  test('run.confirm 对卡住的运行等价于 continue', async ({ context, backend, ext }) => {
    const page = await context.newPage();
    const runId = await startUntilStuck(page, ext, backend);
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'missing';
      document.body.append(b);
    });
    // 没有导航，建议的就是失败的那一步
    await ext.rpc('run.confirm', { runId });
    await ext.waitForRun(runId, succeeded, '继续后成功');
  });

  test('卡住期间中止', async ({ context, backend, ext }) => {
    const page = await context.newPage();
    const runId = await startUntilStuck(page, ext, backend);

    await ext.rpc('run.abort', { runId });
    const run = await ext.waitForRun(runId, (r) => r.status === 'aborted', '中止');
    expect(run.errorCode).toBe('USER_ABORTED');
    expect(run.stuck).toBeUndefined();
    const report = await reportOf(backend, runId);
    expect(report.status).toBe('aborted');
    expect(report.steps).toEqual([
      ['s1', 'succeeded'],
      ['s2', 'failed'],
    ]);
    expect(
      await page.evaluate(
        () => (window as unknown as { __clicks: { next: number } }).__clicks.next,
      ),
    ).toBe(0);
  });

  test('repeat 循环体里的失败不暂停，照常进入下一轮', async ({ context, backend, ext }) => {
    backend.pushRule({
      id: 'e2e-stuck-repeat',
      name: '测试循环体失败',
      version: 1,
      match: { urls: [`${backend.origin()}/pages/step*`] },
      steps: [
        {
          id: 'r1',
          type: 'repeat',
          intervalMs: 1000,
          maxAttempts: 2,
          notify: false,
          steps: [{ id: 'r1a', type: 'click', target: css('#missing'), timeoutMs: 500 }],
          until: { kind: 'element', target: css('#start') },
        },
        { id: 'r2', type: 'click', target: css('#start') },
      ],
    });
    await ext.waitForState((st) => st.rules.some((r) => r.id === 'e2e-stuck-repeat'), '收到规则');
    await ext.rpc('rule.approve', { ruleId: 'e2e-stuck-repeat' });

    const page = await context.newPage();
    await page.goto(`${backend.origin()}/pages/step1.html`);
    const tabId = await ext.tabIdOf(page);
    const { runId } = await ext.rpc('run.start', { ruleId: 'e2e-stuck-repeat', tabId });
    const seen: boolean[] = [];
    const run = await ext.waitForRun(
      runId,
      (r) => {
        seen.push(!!r.stuck);
        return r.status === 'succeeded';
      },
      '循环条件满足后成功',
    );
    expect(seen.some(Boolean)).toBe(false);
    expect(run.errorCode).toBeUndefined();
    const report = await reportOf(backend, runId);
    expect(report.steps).toEqual([
      ['r1a', 'failed'],
      ['r2', 'succeeded'],
    ]);
  });
});
