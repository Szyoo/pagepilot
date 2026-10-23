import type { Rule } from '../../src/schema/rule';
import { ruleSchema } from '../../src/schema/rule';

const target = (value: string) => ({ strategies: [{ kind: 'css' as const, value }] });

/** 构造一条合法规则的原始对象（未经 schema 处理），可覆盖任意字段 */
export function rawRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1',
    name: '规则',
    version: 1,
    match: { urls: ['https://example.com/*'] },
    steps: [{ id: 's1', type: 'click', target: target('#go') }],
    ...overrides,
  };
}

export function makeRule(overrides: Record<string, unknown> = {}): Rule {
  return ruleSchema.parse(rawRule(overrides));
}

export const css = target;

const THEN = 'then';

/** 构造 if 步骤；用计算属性名规避 noThenProperty 规则（规则格式里分支字段就叫 then） */
export function ifStep(
  id: string,
  condition: unknown,
  thenSteps: unknown[],
  elseSteps?: unknown[],
): Record<string, unknown> {
  return {
    id,
    type: 'if',
    condition,
    [THEN]: thenSteps,
    ...(elseSteps ? { else: elseSteps } : {}),
  };
}
