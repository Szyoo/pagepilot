import { describe, expect, it } from 'vitest';
import { downlinkSchema, uplinkSchema } from '../../../src/schema/message';
import { css, rawRule } from '../../helpers/rule-fixtures';

const env = { v: 1, id: 'm1' };

describe('uplinkSchema', () => {
  it('接受 hello（lastSeq 可选）', () => {
    const base = {
      ...env,
      kind: 'hello',
      clientId: 'c',
      extVersion: '0.1.0',
      ruleSchemaVersion: 1,
    };
    expect(uplinkSchema.safeParse(base).success).toBe(true);
    expect(uplinkSchema.safeParse({ ...base, lastSeq: 42 }).success).toBe(true);
  });

  it('接受 ack / resync / ping / pong', () => {
    expect(uplinkSchema.safeParse({ ...env, kind: 'ack', seq: 3 }).success).toBe(true);
    for (const kind of ['resync', 'ping', 'pong']) {
      expect(uplinkSchema.safeParse({ ...env, kind }).success).toBe(true);
    }
  });

  it('ack 的 seq 为负数被拒', () => {
    expect(uplinkSchema.safeParse({ ...env, kind: 'ack', seq: -1 }).success).toBe(false);
  });

  it('协议版本不是 1 被拒', () => {
    expect(uplinkSchema.safeParse({ v: 2, id: 'm', kind: 'ping' }).success).toBe(false);
  });

  it('id 为空被拒', () => {
    expect(uplinkSchema.safeParse({ v: 1, id: '', kind: 'ping' }).success).toBe(false);
  });

  it('capture 的敏感字段默认 false，locator 必填', () => {
    const msg = {
      ...env,
      kind: 'capture',
      pageUrl: 'https://example.com/',
      title: 't',
      capturedAt: 1,
      elements: [{ tag: 'input', attrs: {}, locator: css('#a') }],
    };
    const res = uplinkSchema.parse(msg);
    expect(res.kind === 'capture' && res.elements[0]?.sensitive).toBe(false);
    const bad = { ...msg, elements: [{ tag: 'input', attrs: {} }] };
    expect(uplinkSchema.safeParse(bad).success).toBe(false);
  });

  it('recording 的步骤要通过 stepSchema 校验', () => {
    const ok = {
      ...env,
      kind: 'recording',
      recordingId: 'r',
      startedAt: 1,
      steps: [{ id: 's1', type: 'click', target: css('#a') }],
    };
    expect(uplinkSchema.safeParse(ok).success).toBe(true);
    const bad = { ...ok, steps: [{ id: 's1', type: 'click' }] };
    expect(uplinkSchema.safeParse(bad).success).toBe(false);
  });

  it('runReport 校验状态与错误码枚举', () => {
    const ok = {
      ...env,
      kind: 'runReport',
      runId: 'r',
      ruleId: 'x',
      ruleVersion: 1,
      trigger: 'manual',
      startedAt: 1,
      endedAt: 2,
      status: 'failed',
      inputMode: 'trusted',
      steps: [{ stepId: 's1', status: 'failed', attempts: 1, durationMs: 5, errorCode: 'TIMEOUT' }],
    };
    expect(uplinkSchema.safeParse(ok).success).toBe(true);
    const bad = { ...ok, steps: [{ ...ok.steps[0], errorCode: 'NOPE' }] };
    expect(uplinkSchema.safeParse(bad).success).toBe(false);
    expect(uplinkSchema.safeParse({ ...ok, inputMode: 'auto' }).success).toBe(false);
  });

  it('未知 kind 被拒', () => {
    expect(uplinkSchema.safeParse({ ...env, kind: 'nope' }).success).toBe(false);
  });
});

describe('downlinkSchema', () => {
  it('接受 snapshot / ruleUpsert / ruleRemove', () => {
    expect(downlinkSchema.safeParse({ ...env, kind: 'snapshot', seq: 1, rules: [] }).success).toBe(
      true,
    );
    expect(
      downlinkSchema.safeParse({ ...env, kind: 'ruleUpsert', seq: 2, rule: rawRule() }).success,
    ).toBe(true);
    expect(
      downlinkSchema.safeParse({ ...env, kind: 'ruleRemove', seq: 3, ruleId: 'r1' }).success,
    ).toBe(true);
  });

  it('snapshot 里的坏规则不会让整条消息失败', () => {
    const msg = {
      ...env,
      kind: 'snapshot',
      seq: 1,
      rules: [rawRule(), { id: 'broken', steps: 'not-an-array' }],
    };
    const res = downlinkSchema.safeParse(msg);
    expect(res.success).toBe(true);
    expect(res.success && res.data.kind === 'snapshot' && res.data.rules).toHaveLength(2);
  });

  it('ruleUpsert 的坏规则也只在下游校验，消息本身通过', () => {
    expect(
      downlinkSchema.safeParse({ ...env, kind: 'ruleUpsert', seq: 1, rule: { foo: 1 } }).success,
    ).toBe(true);
  });

  it('rules 不是对象数组时消息被拒', () => {
    expect(
      downlinkSchema.safeParse({ ...env, kind: 'snapshot', seq: 1, rules: ['x'] }).success,
    ).toBe(false);
  });

  it('下行同步消息必须带 seq', () => {
    expect(downlinkSchema.safeParse({ ...env, kind: 'ruleRemove', ruleId: 'r' }).success).toBe(
      false,
    );
  });

  it('error 的 message 可选，code 为任意字符串', () => {
    expect(downlinkSchema.safeParse({ ...env, kind: 'error', code: 'X' }).success).toBe(true);
    expect(downlinkSchema.safeParse({ ...env, kind: 'error' }).success).toBe(false);
  });

  it('ping / pong 通过，上行专属的 ack 被拒', () => {
    expect(downlinkSchema.safeParse({ ...env, kind: 'ping' }).success).toBe(true);
    expect(downlinkSchema.safeParse({ ...env, kind: 'ack', seq: 1 }).success).toBe(false);
  });
});
