// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSPECT_MAX_ELEMENTS, inspectElements } from '../../../src/core/capture';
import { html, mockLayout } from '../../helpers/dom';

beforeEach(() => {
  html('');
  mockLayout();
});
afterEach(() => vi.restoreAllMocks());

describe('inspectElements（「请 AI 看看」的页面概要）', () => {
  it('只保留标签、角色、文字与敏感标记，不带属性与定位器', () => {
    html('<button id="go" data-testid="x" class="c">提交订单</button>');
    expect(inspectElements()).toEqual([
      { tag: 'button', role: 'button', text: '提交订单', sensitive: false },
    ]);
  });

  it('不带输入框、文本域、可编辑区域里的内容，只用标签或 placeholder', () => {
    html(
      '<label for="n">姓名</label><input id="n" value="输入值-AAA">' +
        '<textarea placeholder="备注">文本域-BBB</textarea>' +
        '<div contenteditable="true">可编辑-CCC</div>' +
        '<select aria-label="城市"><option selected>选项-DDD</option></select>',
    );
    const els = inspectElements();
    const all = JSON.stringify(els);
    for (const v of ['AAA', 'BBB', 'CCC', 'DDD']) expect(all).not.toContain(v);
    expect(els.map((e) => e.text)).toEqual(['姓名', '备注', undefined, '城市']);
  });

  it('敏感元素不带文字', () => {
    html('<label for="p">登录密码</label><input id="p" type="password" value="pw-EEE">');
    const [el] = inspectElements();
    expect(el).toEqual({ tag: 'input', role: 'textbox', sensitive: true });
  });

  it('文字截断到 60 字，最多 120 个元素，跳过不可见元素', () => {
    const long = '长'.repeat(100);
    html(
      `<button style="display:none">隐藏</button><button>${long}</button>` +
        Array.from({ length: 200 }, (_, i) => `<a href="/p${i}">链接${i}</a>`).join(''),
    );
    const els = inspectElements();
    expect(els).toHaveLength(INSPECT_MAX_ELEMENTS);
    expect(els[0]?.text).toHaveLength(60);
    expect(JSON.stringify(els)).not.toContain('隐藏');
  });
});
