// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateCondition } from '../../../src/core/selector/condition';
import type { Condition } from '../../../src/schema/rule';
import { $, html, mockLayout } from '../../helpers/dom';

const el = (selector: string, extra: Record<string, unknown> = {}): Condition =>
  ({
    kind: 'element',
    target: { strategies: [{ kind: 'css', value: selector }] },
    visible: true,
    ...extra,
  }) as Condition;

beforeEach(() => {
  html('');
  history.pushState({}, '', '/');
});
afterEach(() => vi.restoreAllMocks());

describe('element 条件的 filled（输入框已填满）', () => {
  const field = (attrs: string, value = '') => {
    html(`<input id="c" ${attrs}>`);
    mockLayout();
    ($('#c') as HTMLInputElement).value = value;
  };

  it('有 maxlength 时，长度达到它才算填满', () => {
    field('maxlength="6"', '12345');
    expect(evaluateCondition(el('#c', { filled: true }))).toBe(false);
    ($('#c') as HTMLInputElement).value = '123456';
    expect(evaluateCondition(el('#c', { filled: true }))).toBe(true);
  });

  it('没有 maxlength 时，非空就算填满', () => {
    field('', '');
    expect(evaluateCondition(el('#c', { filled: true }))).toBe(false);
    ($('#c') as HTMLInputElement).value = 'a';
    expect(evaluateCondition(el('#c', { filled: true }))).toBe(true);
  });

  it('目标不是输入框时不成立；不写 filled 时不检查填写情况', () => {
    html('<div id="d">123456</div>');
    mockLayout();
    expect(evaluateCondition(el('#d', { filled: true }))).toBe(false);
    expect(evaluateCondition(el('#d'))).toBe(true);
  });
});

describe('element 条件的 minLength（至少几个字符）', () => {
  it('验证码实际是 5 位而输入框 maxlength 是 6：输满 5 位就成立，filled 则要 6 位', () => {
    html('<input id="c" maxlength="6">');
    mockLayout();
    const input = $('#c') as HTMLInputElement;
    input.value = '1234';
    expect(evaluateCondition(el('#c', { minLength: 5 }))).toBe(false);
    input.value = '12345';
    expect(evaluateCondition(el('#c', { minLength: 5 }))).toBe(true);
    expect(evaluateCondition(el('#c', { filled: true }))).toBe(false);
    input.value = '123456';
    expect(evaluateCondition(el('#c', { filled: true }))).toBe(true);
  });

  it('目标不是输入框时不成立', () => {
    html('<div id="d">12345</div>');
    mockLayout();
    expect(evaluateCondition(el('#d', { minLength: 1 }))).toBe(false);
  });
});

describe('element 条件', () => {
  it('元素不存在时不成立', () => {
    mockLayout();
    expect(evaluateCondition(el('#none'))).toBe(false);
  });

  it('visible 默认要求可见：不可见时不成立，visible=false 时只要存在即可', () => {
    html('<div id="a">x</div>'); // jsdom 无布局，等价于不可见
    expect(evaluateCondition(el('#a'))).toBe(false);
    expect(evaluateCondition(el('#a', { visible: false }))).toBe(true);
  });

  it('可见元素成立', () => {
    mockLayout();
    html('<div id="a">x</div>');
    expect(evaluateCondition(el('#a'))).toBe(true);
  });

  it('display:none 的元素在 visible=true 时不成立', () => {
    mockLayout();
    html('<div id="a" style="display:none">x</div>');
    expect(evaluateCondition(el('#a'))).toBe(false);
    expect(evaluateCondition(el('#a', { visible: false }))).toBe(true);
  });

  it('命中多个元素视为不存在', () => {
    mockLayout();
    html('<i class="a"></i><i class="a"></i>');
    expect(evaluateCondition(el('.a'))).toBe(false);
  });

  it('text：文本包含即成立', () => {
    mockLayout();
    html('<div id="a">剩余名额 3</div>');
    expect(evaluateCondition(el('#a', { text: '名额' }))).toBe(true);
    expect(evaluateCondition(el('#a', { text: '已满' }))).toBe(false);
  });

  it('text 对输入框读取 value', () => {
    mockLayout();
    html('<input id="a" value="hello">');
    expect(evaluateCondition(el('#a', { text: 'ell' }))).toBe(true);
  });

  it('textMatch：按正则匹配文本', () => {
    mockLayout();
    html('<div id="a">剩余名额 12</div>');
    expect(evaluateCondition(el('#a', { textMatch: '名额 \\d+$' }))).toBe(true);
    expect(evaluateCondition(el('#a', { textMatch: '^名额' }))).toBe(false);
  });

  it('textMatch 不是合法正则时不成立而不是抛错', () => {
    mockLayout();
    html('<div id="a">x</div>');
    expect(evaluateCondition(el('#a', { textMatch: '(' }))).toBe(false);
  });

  it('text 与 textMatch 同时给出时需都满足', () => {
    mockLayout();
    html('<div id="a">abc 123</div>');
    expect(evaluateCondition(el('#a', { text: 'abc', textMatch: '\\d+' }))).toBe(true);
    expect(evaluateCondition(el('#a', { text: 'abc', textMatch: 'z' }))).toBe(false);
  });

  it('经过跨域 iframe 的元素条件视为不成立', () => {
    mockLayout();
    html('<iframe id="f"></iframe>');
    Object.defineProperty($('#f'), 'contentDocument', { get: () => null });
    const c = el('#x', { target: { strategies: [{ kind: 'css', value: '#x' }], frame: ['#f'] } });
    expect(evaluateCondition(c)).toBe(false);
  });
});

describe('url 条件', () => {
  it('按 glob 匹配当前页面 URL', () => {
    history.pushState({}, '', '/booking/step1?x=1');
    expect(evaluateCondition({ kind: 'url', pattern: `${location.origin}/booking/*` })).toBe(true);
    expect(evaluateCondition({ kind: 'url', pattern: `${location.origin}/login*` })).toBe(false);
  });
});

describe('组合条件', () => {
  const yes: Condition = { kind: 'url', pattern: '*' };
  const no: Condition = { kind: 'url', pattern: 'https://never.invalid/*' };

  it('not 取反', () => {
    expect(evaluateCondition({ kind: 'not', condition: no })).toBe(true);
    expect(evaluateCondition({ kind: 'not', condition: yes })).toBe(false);
  });

  it('all 需全部成立', () => {
    expect(evaluateCondition({ kind: 'all', conditions: [yes, yes] })).toBe(true);
    expect(evaluateCondition({ kind: 'all', conditions: [yes, no] })).toBe(false);
  });

  it('any 任一成立即可', () => {
    expect(evaluateCondition({ kind: 'any', conditions: [no, yes] })).toBe(true);
    expect(evaluateCondition({ kind: 'any', conditions: [no, no] })).toBe(false);
  });

  it('可以嵌套：not(any(元素存在, url 不匹配))', () => {
    mockLayout();
    html('<b id="x">1</b>');
    const c: Condition = { kind: 'not', condition: { kind: 'any', conditions: [el('#x'), no] } };
    expect(evaluateCondition(c)).toBe(false);
    html('');
    expect(evaluateCondition(c)).toBe(true);
  });
});
