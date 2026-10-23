import { describe, expect, it } from 'vitest';
import { extractPlaceholders, renderTemplate } from '../../../src/shared/template';

describe('extractPlaceholders', () => {
  it('提取三种作用域的占位符并保持顺序', () => {
    expect(extractPlaceholders('{{profile.name}}-{{secret.pass}}-{{var.token}}')).toEqual([
      { scope: 'profile', key: 'name' },
      { scope: 'secret', key: 'pass' },
      { scope: 'var', key: 'token' },
    ]);
  });

  it('允许花括号内的空白与点、横线、下划线键名', () => {
    expect(extractPlaceholders('{{  profile.a.b-c_d  }}')).toEqual([
      { scope: 'profile', key: 'a.b-c_d' },
    ]);
  });

  it('转义的 \\{{ 不算占位符', () => {
    expect(extractPlaceholders('\\{{secret.x}}')).toEqual([]);
  });

  it('转义不影响同一文本中其他占位符', () => {
    expect(extractPlaceholders('\\{{secret.x}} {{profile.y}}')).toEqual([
      { scope: 'profile', key: 'y' },
    ]);
  });

  it('未知作用域、表达式、缺 key 的写法不识别', () => {
    expect(
      extractPlaceholders('{{env.x}} {{profile.}} {{profile.a | upper}} {{ profile }}'),
    ).toEqual([]);
  });

  it('多次调用结果一致（正则无状态残留）', () => {
    const t = '{{var.a}}';
    expect(extractPlaceholders(t)).toEqual(extractPlaceholders(t));
  });
});

describe('renderTemplate', () => {
  it('用解析器结果替换占位符', () => {
    const out = renderTemplate(
      '你好 {{profile.name}}，{{var.n}}',
      (scope, key) => `[${scope}:${key}]`,
    );
    expect(out).toBe('你好 [profile:name]，[var:n]');
  });

  it('转义的 \\{{ 渲染为 {{ 且其后文本保持原样', () => {
    const out = renderTemplate('a\\{{secret.x}}b', () => 'X');
    expect(out).toBe('a{{secret.x}}b');
  });

  it('解析器抛错时整体失败，不返回带占位符原文的结果', () => {
    expect(() =>
      renderTemplate('{{profile.a}} {{secret.b}}', (scope) => {
        if (scope === 'secret') throw new Error('locked');
        return 'ok';
      }),
    ).toThrow('locked');
  });

  it('替换值里含占位符形式时不会被二次解析', () => {
    const out = renderTemplate('{{var.a}}', () => '{{secret.x}}');
    expect(out).toBe('{{secret.x}}');
  });

  it('没有占位符的文本原样返回', () => {
    expect(renderTemplate('plain', () => 'x')).toBe('plain');
  });
});
