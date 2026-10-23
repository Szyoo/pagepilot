import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { downlinkSchema } from '../../../src/schema/message';
import { ruleSchema } from '../../../src/schema/rule';

const samplesPath = process.env.PAGEPILOT_SAMPLES;

describe.skipIf(!samplesPath)('后台输出符合扩展的 schema', () => {
  const read = (key: string): unknown[] => {
    const all = JSON.parse(readFileSync(samplesPath ?? '', 'utf8')) as Record<string, unknown[]>;
    return all[key] ?? [];
  };

  it('下行消息全部通过 downlinkSchema，其中的规则通过 ruleSchema', () => {
    const messages = read('downlink');
    expect(messages.length).toBeGreaterThan(0);
    for (const raw of messages) {
      const res = downlinkSchema.safeParse(raw);
      expect(res.success, JSON.stringify(res.error?.issues)).toBe(true);
      if (!res.success) continue;
      const msg = res.data;
      const rules =
        msg.kind === 'snapshot' ? msg.rules : msg.kind === 'ruleUpsert' ? [msg.rule] : [];
      for (const rule of rules) {
        const parsed = ruleSchema.safeParse(rule);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      }
    }
  });

  it('后台的规则校验结论与 ruleSchema 一致', () => {
    const cases = read('rules') as { rule: unknown; ok: boolean }[];
    expect(cases.length).toBeGreaterThan(0);
    for (const { rule, ok } of cases) {
      const res = ruleSchema.safeParse(rule);
      expect(res.success, JSON.stringify({ rule, issues: res.error?.issues })).toBe(ok);
    }
  });
});
