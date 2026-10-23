import { describe, expect, it } from 'vitest';
import { flattenSteps, ruleSchema } from '../../../src/schema/rule';
import { css, ifStep, rawRule } from '../../helpers/rule-fixtures';

const exampleRule = {
  id: 'booking-demo',
  name: '预约示例',
  version: 1,
  trigger: 'manual',
  inputMode: 'trusted',
  match: { urls: ['https://example.com/*'] },
  requires: { profile: ['name', 'phone'], secret: ['user', 'pass'] },
  login: {
    loggedIn: { kind: 'element', target: { strategies: [{ kind: 'testid', value: 'user-menu' }] } },
    steps: [
      { id: 'l1', type: 'open', url: 'https://example.com/login' },
      { id: 'l2', type: 'fill', target: css('#user'), value: '{{secret.user}}' },
      { id: 'l3', type: 'fill', target: css('#pass'), value: '{{secret.pass}}' },
      {
        id: 'l4',
        type: 'handoff',
        message: '请完成验证并点击登录',
        resumeWhen: 'condition',
        until: {
          kind: 'element',
          target: { strategies: [{ kind: 'testid', value: 'user-menu' }] },
        },
      },
    ],
  },
  steps: [
    { id: 's1', type: 'open', url: 'https://example.com/booking' },
    {
      id: 's2',
      type: 'repeat',
      reload: true,
      intervalMs: 8000,
      jitterMs: 4000,
      maxAttempts: 300,
      onExhausted: 'handoff',
      steps: [{ id: 's2a', type: 'waitFor', until: 'idle' }],
      until: { kind: 'element', target: css('.slot.available') },
    },
    { id: 's3', type: 'click', target: css('.slot.available') },
    { id: 's4', type: 'fill', target: css('#name'), value: '{{profile.name}}' },
    { id: 's5', type: 'fill', target: css('#phone'), value: '{{profile.phone}}' },
    ifStep('s6', { kind: 'element', target: css('#agree') }, [
      { id: 's6a', type: 'check', target: css('#agree'), checked: true },
    ]),
    { id: 's7', type: 'handoff', message: '请确认信息并提交', final: true },
  ],
};

const click = (id: string) => ({ id, type: 'click', target: css('#x') });
const cond = { kind: 'element', target: css('#c') };
const nest = (depth: number): Record<string, unknown> => {
  // 最内层为 click，外面包 depth 层 if
  let step: Record<string, unknown> = click('leaf');
  for (let i = depth; i >= 1; i--) {
    step = ifStep(`if${i}`, cond, [step]);
  }
  return step;
};

const parse = (overrides: Record<string, unknown>) => ruleSchema.safeParse(rawRule(overrides));

describe('ruleSchema 合法规则', () => {
  it('接受带 login / repeat / if / handoff 的完整示例', () => {
    const res = ruleSchema.safeParse(exampleRule);
    expect(res.success).toBe(true);
  });

  it('填充规则与步骤的默认值', () => {
    const rule = ruleSchema.parse(rawRule());
    expect(rule).toMatchObject({
      enabled: true,
      trigger: 'manual',
      inputMode: 'auto',
      match: { exclude: [] },
      requires: { profile: [], secret: [] },
    });
    expect(rule.steps[0]).toMatchObject({ timeoutMs: 15000, retries: 0, optional: false });
  });

  it('填充 repeat 的默认值', () => {
    const rule = ruleSchema.parse(
      rawRule({
        steps: [{ id: 'r', type: 'repeat', steps: [click('a')], until: cond }],
      }),
    );
    expect(rule.steps[0]).toMatchObject({
      reload: false,
      intervalMs: 5000,
      jitterMs: 0,
      maxAttempts: 100,
      onExhausted: 'fail',
      notify: true,
      sound: false,
    });
  });

  it('填充 handoff、fill、open、element 条件的默认值', () => {
    const rule = ruleSchema.parse(
      rawRule({
        steps: [
          { id: 'h', type: 'handoff', message: 'm' },
          { id: 'f', type: 'fill', target: css('#a'), value: 'v' },
          { id: 'o', type: 'open', url: 'https://example.com/' },
          { id: 'a', type: 'assert', condition: cond },
        ],
      }),
    );
    expect(rule.steps[0]).toMatchObject({ resumeWhen: 'userConfirm', final: false });
    expect(rule.steps[1]).toMatchObject({ clear: true });
    expect(rule.steps[2]).toMatchObject({ newTab: false });
    expect(rule.steps[3]).toMatchObject({ condition: { visible: true } });
  });

  it('flattenSteps 按出现顺序展开登录与嵌套步骤', () => {
    const rule = ruleSchema.parse(exampleRule);
    expect(flattenSteps(rule).map((s) => s.id)).toEqual([
      'l1',
      'l2',
      'l3',
      'l4',
      's1',
      's2',
      's2a',
      's3',
      's4',
      's5',
      's6',
      's6a',
      's7',
    ]);
  });
});

describe('ruleSchema match.urls', () => {
  it.each(['<all_urls>', '*://*/*', 'https://*/*', '*'])('拒绝匹配全部网站的写法 %s', (u) => {
    expect(parse({ match: { urls: [u] } }).success).toBe(false);
  });

  it('接受 https://*.example.com/*', () => {
    expect(parse({ match: { urls: ['https://*.example.com/*'] } }).success).toBe(true);
  });

  it('只要有一条过宽就整体拒绝', () => {
    expect(parse({ match: { urls: ['https://example.com/*', '<all_urls>'] } }).success).toBe(false);
  });

  it('urls 为空数组被拒绝', () => {
    expect(parse({ match: { urls: [] } }).success).toBe(false);
  });
});

describe('ruleSchema 占位符约束', () => {
  const fillSecret = (id = 's1') => ({
    id,
    type: 'fill',
    target: css('#p'),
    value: '{{secret.pass}}',
  });

  it('fill.value 中的 secret 在 requires 声明后通过', () => {
    expect(parse({ requires: { secret: ['pass'] }, steps: [fillSecret()] }).success).toBe(true);
  });

  it('secret 出现在 open.url 被拒', () => {
    const res = parse({
      requires: { secret: ['pass'] },
      steps: [{ id: 's1', type: 'open', url: 'https://example.com/?p={{secret.pass}}' }],
    });
    expect(res.success).toBe(false);
  });

  it('secret 出现在 select.value 被拒', () => {
    const res = parse({
      requires: { secret: ['pass'] },
      steps: [{ id: 's1', type: 'select', target: css('#a'), value: '{{secret.pass}}' }],
    });
    expect(res.success).toBe(false);
  });

  it('secret 出现在 fill 的 note 里被拒', () => {
    const res = parse({
      requires: { secret: ['pass'] },
      steps: [{ ...fillSecret(), note: '密码 {{secret.pass}}' }],
    });
    expect(res.success).toBe(false);
  });

  it('secret 出现在条件的 text 中被拒', () => {
    const res = parse({
      requires: { secret: ['pass'] },
      steps: [
        {
          id: 's1',
          type: 'assert',
          condition: { kind: 'element', target: css('#a'), text: '{{secret.pass}}' },
        },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('secret 出现在 fill 的 target 中被拒', () => {
    const res = parse({
      requires: { secret: ['pass'] },
      steps: [
        {
          id: 's1',
          type: 'fill',
          target: css('input[value="{{secret.pass}}"]'),
          value: 'x',
        },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('secret 出现在嵌套 if 的 fill.value 中仍然允许', () => {
    const res = parse({
      requires: { secret: ['pass'] },
      steps: [ifStep('i', cond, [fillSecret('f')])],
    });
    expect(res.success).toBe(true);
  });

  it('requires.secret 未覆盖占位符被拒', () => {
    expect(parse({ steps: [fillSecret()] }).success).toBe(false);
  });

  it('requires.profile 未覆盖占位符被拒', () => {
    const res = parse({
      steps: [{ id: 's1', type: 'fill', target: css('#a'), value: '{{profile.name}}' }],
    });
    expect(res.success).toBe(false);
  });

  it('requires 覆盖 login 步骤中的占位符才通过', () => {
    const login = {
      loggedIn: cond,
      steps: [fillSecret('l1')],
    };
    expect(parse({ login }).success).toBe(false);
    expect(parse({ login, requires: { secret: ['pass'] } }).success).toBe(true);
  });

  it('{{var.x}} 不需要声明且可出现在任意文本字段', () => {
    const res = parse({
      steps: [{ id: 's1', type: 'open', url: 'https://example.com/{{var.token}}' }],
    });
    expect(res.success).toBe(true);
  });

  it('转义的 \\{{secret.x}} 不算占位符', () => {
    const res = parse({
      steps: [{ id: 's1', type: 'fill', target: css('#a'), value: '\\{{secret.pass}}' }],
    });
    expect(res.success).toBe(true);
  });

  it('转义只作用于紧随其后的一处，后面的真实占位符仍被检查', () => {
    const res = parse({
      steps: [
        { id: 's1', type: 'open', url: 'a\\{{x}} {{secret.pass}}' },
        // 同一字符串里的真实 secret 仍应被识别（open 不允许）
      ],
      requires: { secret: ['pass'] },
    });
    expect(res.success).toBe(false);
  });
});

describe('ruleSchema 步骤约束', () => {
  it('步骤 id 重复被拒', () => {
    expect(parse({ steps: [click('a'), click('a')] }).success).toBe(false);
  });

  it('嵌套步骤与外层 id 重复也被拒', () => {
    const res = parse({
      steps: [ifStep('a', cond, [click('a')])],
    });
    expect(res.success).toBe(false);
  });

  it('login 步骤与主流程 id 重复被拒', () => {
    const res = parse({ login: { loggedIn: cond, steps: [click('s1')] } });
    expect(res.success).toBe(false);
  });

  it('嵌套 3 层通过', () => {
    expect(parse({ steps: [nest(3)] }).success).toBe(true);
  });

  it('嵌套超过 3 层被拒', () => {
    expect(parse({ steps: [nest(4)] }).success).toBe(false);
  });

  it('if 的 else 分支同样计入嵌套深度', () => {
    const deep = ifStep(
      'a1',
      cond,
      [click('t')],
      [
        {
          id: 'a2',
          type: 'repeat',
          steps: [ifStep('a3', cond, [ifStep('a4', cond, [click('x')])])],
          until: cond,
        },
      ],
    );
    expect(parse({ steps: [deep] }).success).toBe(false);
  });

  it('waitFor(condition) 缺 condition 被拒，带 condition 通过', () => {
    expect(parse({ steps: [{ id: 'w', type: 'waitFor', until: 'condition' }] }).success).toBe(
      false,
    );
    expect(
      parse({ steps: [{ id: 'w', type: 'waitFor', until: 'condition', condition: cond }] }).success,
    ).toBe(true);
  });

  it('waitFor(delay) 缺 delayMs 被拒，带 delayMs 通过', () => {
    expect(parse({ steps: [{ id: 'w', type: 'waitFor', until: 'delay' }] }).success).toBe(false);
    expect(
      parse({ steps: [{ id: 'w', type: 'waitFor', until: 'delay', delayMs: 500 }] }).success,
    ).toBe(true);
  });

  it('waitFor(idle / navigation / newTab) 无需额外字段', () => {
    for (const until of ['idle', 'navigation', 'newTab']) {
      expect(parse({ steps: [{ id: 'w', type: 'waitFor', until }] }).success).toBe(true);
    }
  });

  it('handoff(condition) 缺 until 被拒', () => {
    const res = parse({
      steps: [{ id: 'h', type: 'handoff', message: 'm', resumeWhen: 'condition' }],
    });
    expect(res.success).toBe(false);
  });

  it('handoff 的 userConfirm / navigation 不需要 until', () => {
    for (const resumeWhen of ['userConfirm', 'navigation']) {
      expect(
        parse({ steps: [{ id: 'h', type: 'handoff', message: 'm', resumeWhen }] }).success,
      ).toBe(true);
    }
  });

  it('login 内的步骤同样受 waitFor 校验', () => {
    const res = parse({
      login: { loggedIn: cond, steps: [{ id: 'l', type: 'waitFor', until: 'delay' }] },
    });
    expect(res.success).toBe(false);
  });

  it('steps 为空、locator 无策略、未知步骤类型均被拒', () => {
    expect(parse({ steps: [] }).success).toBe(false);
    expect(parse({ steps: [{ id: 'a', type: 'click', target: { strategies: [] } }] }).success).toBe(
      false,
    );
    expect(parse({ steps: [{ id: 'a', type: 'teleport' }] }).success).toBe(false);
  });

  it('version 必须为非负整数', () => {
    expect(parse({ version: -1 }).success).toBe(false);
    expect(parse({ version: 1.5 }).success).toBe(false);
    expect(parse({ version: 0 }).success).toBe(true);
  });

  it('条件支持 not / all / any 嵌套，all 不允许空数组', () => {
    const ok = {
      kind: 'all',
      conditions: [cond, { kind: 'not', condition: { kind: 'url', pattern: 'https://a/*' } }],
    };
    expect(parse({ steps: [{ id: 'a', type: 'assert', condition: ok }] }).success).toBe(true);
    expect(
      parse({ steps: [{ id: 'a', type: 'assert', condition: { kind: 'any', conditions: [] } }] })
        .success,
    ).toBe(false);
  });

  it('element 条件接受 filled，并保留在解析结果里', () => {
    const until = { kind: 'element', target: css('#captcha'), filled: true };
    const res = parse({
      steps: [
        {
          id: 'h',
          type: 'handoff',
          message: '请输入验证码',
          resumeWhen: 'condition',
          until,
        },
      ],
    });
    expect(res.success).toBe(true);
    const step = res.success ? res.data.steps[0] : undefined;
    expect(step?.type === 'handoff' && step.until).toMatchObject({ kind: 'element', filled: true });
  });
});
