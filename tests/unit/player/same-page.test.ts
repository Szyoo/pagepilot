import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', async () => (await import('../../helpers/fake-browser')).browserModule);

const { samePage } = await import('../../../src/shared/glob');
const { usesManualHandoff } = await import('../../../src/core/player/runner');

describe('samePage：open 步骤判断是否已在目标页面', () => {
  it('网站与路径相同即视为同一页面，忽略查询参数、锚点与末尾斜杠', () => {
    expect(
      samePage('https://example.com/en/main.do?lang=en#top', 'https://example.com/en/main.do'),
    ).toBe(true);
    expect(samePage('https://example.com/en/', 'https://example.com/en')).toBe(true);
    expect(samePage('https://example.com/', 'https://example.com')).toBe(true);
  });

  it('路径、主机、协议或端口不同都不是同一页面', () => {
    expect(samePage('https://example.com/en/main.do', 'https://example.com/en/login.do')).toBe(
      false,
    );
    expect(samePage('https://a.example.com/x', 'https://b.example.com/x')).toBe(false);
    expect(samePage('http://example.com/x', 'https://example.com/x')).toBe(false);
    expect(samePage('https://example.com:8443/x', 'https://example.com/x')).toBe(false);
  });

  it('无法解析的地址视为不同', () => {
    expect(samePage('about:blank', 'https://example.com/')).toBe(false);
    expect(samePage('not a url', 'https://example.com/')).toBe(false);
  });
});

describe('usesManualHandoff：规则里写了交还步骤就不做验证码自动检测', () => {
  const click = { id: 'c', type: 'click', target: { strategies: [{ kind: 'css', value: '#a' }] } };
  const handoff = { id: 'h', type: 'handoff', message: '请输入验证码', resumeWhen: 'userConfirm' };
  const rule = (steps: unknown[], login?: unknown[]) =>
    ({
      steps,
      ...(login ? { login: { loggedIn: { kind: 'url', pattern: '*' }, steps: login } } : {}),
    }) as never;

  it('没有交还步骤时为 false', () => {
    expect(usesManualHandoff(rule([click]))).toBe(false);
  });

  it('主流程、登录步骤或嵌套步骤里有交还都为 true', () => {
    expect(usesManualHandoff(rule([click, handoff]))).toBe(true);
    expect(usesManualHandoff(rule([click], [handoff]))).toBe(true);
    const nested = {
      id: 'i',
      type: 'if',
      condition: { kind: 'url', pattern: '*' },
      // biome-ignore lint/suspicious/noThenProperty: 规则格式中 if 的分支字段就叫 then
      then: [handoff],
    };
    expect(usesManualHandoff(rule([click, nested]))).toBe(true);
  });
});
