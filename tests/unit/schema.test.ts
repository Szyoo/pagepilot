import { describe, expect, it } from 'vitest';
import { ruleSchema } from '../../src/schema';

describe('ruleSchema', () => {
  it('接受带交还步骤的规则', () => {
    const rule = ruleSchema.parse({
      id: 'demo',
      name: '示例',
      version: 1,
      match: { urls: ['https://example.com/*'] },
      steps: [
        { id: 's1', type: 'open', url: 'https://example.com/login' },
        {
          id: 's2',
          type: 'fill',
          target: { strategies: [{ kind: 'css', value: '#user' }] },
          value: '{{secret.user}}',
        },
        { id: 's3', type: 'handoff', message: '请完成验证码', final: false },
      ],
    });
    expect(rule.steps).toHaveLength(3);
  });
});
