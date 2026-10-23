// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecorder } from '../../../src/core/recorder';
import { resolve } from '../../../src/core/selector';
import type { RecordedAction } from '../../../src/shared/content-api';
import { $, html, installTrustBridge, trusted } from '../../helpers/dom';

/**
 * recorder 的每个监听器都先检查 ev.isTrusted。jsdom 里 dispatchEvent 的事件 isTrusted 恒为 false，
 * 且该属性不可配置（Object.defineProperty 会抛 Cannot redefine property），
 * 所以用 installTrustBridge() + trusted() 让被标记的事件在监听器里表现为 isTrusted=true。
 */
const click = (el: Element) =>
  el.dispatchEvent(trusted(new MouseEvent('click', { bubbles: true })));
const change = (el: Element) => el.dispatchEvent(trusted(new Event('change', { bubbles: true })));
const keydown = (el: Element, key: string) =>
  el.dispatchEvent(trusted(new KeyboardEvent('keydown', { key, bubbles: true })));

let actions: RecordedAction[];
let recorder: ReturnType<typeof createRecorder>;

beforeEach(() => {
  html('');
  actions = [];
  installTrustBridge();
  recorder = createRecorder((a) => actions.push(a));
  recorder.start();
});
afterEach(() => {
  recorder.stop();
  vi.restoreAllMocks();
});

describe('点击', () => {
  it('点击按钮记录 click，locator 能解析回该按钮', () => {
    html('<button id="go">提交</button>');
    click($('#go'));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe('click');
    const a = actions[0] as Extract<RecordedAction, { kind: 'click' }>;
    expect(resolve(a.locator).element).toBe($('#go'));
  });

  it('点击按钮内部的子元素，记录到最近的可点击祖先', () => {
    html('<button id="go"><span id="inner">提交</span></button>');
    click($('#inner'));
    const a = actions[0] as Extract<RecordedAction, { kind: 'click' }>;
    expect(resolve(a.locator).element).toBe($('#go'));
  });

  it('点击普通链接与 role=button 的元素也记录', () => {
    html('<a id="l" href="#x">链接</a><div id="r" role="button">按钮</div>');
    click($('#l'));
    click($('#r'));
    expect(actions.map((a) => a.kind)).toEqual(['click', 'click']);
  });

  it.each([
    ['文本框', '<input id="t" type="text">'],
    ['文本域', '<textarea id="t"></textarea>'],
    ['下拉框', '<select id="t"><option>a</option></select>'],
  ])('点击%s本身不记录（由 change 记录）', (_n, markup) => {
    html(markup);
    click($('#t'));
    expect(actions).toEqual([]);
  });

  it.each(['checkbox', 'radio'])(
    '点击 %s 只记录 check（来自随后的 change），不记录 click',
    (type) => {
      html(`<input id="t" type="${type}">`);
      click($('#t'));
      expect(actions.map((a) => a.kind)).toEqual(['check']);
      expect(actions[0]).toMatchObject({ checked: true });
    },
  );

  it('提交按钮（input[type=submit]）的点击会被记录', () => {
    html('<form><input id="s" type="submit" value="发送"></form>');
    $('form').addEventListener('submit', (e) => e.preventDefault());
    click($('#s'));
    expect(actions.map((a) => a.kind)).toEqual(['click']);
  });
});

describe('文本输入', () => {
  it('change 时记录 fill，带当前值，非敏感', () => {
    html('<input id="u" name="username" type="text">');
    const input = $<HTMLInputElement>('#u');
    input.value = '张三';
    change(input);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'fill',
      value: '张三',
      sensitive: false,
      fieldName: 'username',
    });
    const a = actions[0] as Extract<RecordedAction, { kind: 'fill' }>;
    expect(resolve(a.locator).element).toBe(input);
  });

  it('值没有变化时再次 change 不重复记录，变化后继续记录', () => {
    html('<input id="u" name="u">');
    const input = $<HTMLInputElement>('#u');
    input.value = 'a';
    change(input);
    change(input);
    input.value = 'b';
    change(input);
    expect(actions.map((a) => (a as { value?: string }).value)).toEqual(['a', 'b']);
  });

  it('textarea 同样记录 fill', () => {
    html('<textarea id="t" name="remark"></textarea>');
    $<HTMLTextAreaElement>('#t').value = '备注';
    change($('#t'));
    expect(actions[0]).toMatchObject({ kind: 'fill', value: '备注', fieldName: 'remark' });
  });

  it('字段名由 name / id / aria-label / type 依次得出，并清理为安全字符', () => {
    html(
      '<input id="a" name="user[first name]">' +
        '<input id="b2">' +
        '<input aria-label="手机 号!">' +
        '<input type="tel">',
    );
    for (const el of document.querySelectorAll('input')) {
      el.value = 'v';
      change(el);
    }
    expect(actions.map((a) => (a as { fieldName?: string }).fieldName)).toEqual([
      'user_first_name',
      'b2',
      'field', // 全部是非 ASCII 字符，清理后为空，回退为 field
      'tel',
    ]);
  });
});

describe('敏感字段', () => {
  it('密码框的 fill 带 sensitive=true 与字段名', () => {
    html('<input id="p" name="pass" type="password">');
    $<HTMLInputElement>('#p').value = 'hunter2';
    change($('#p'));
    expect(actions[0]).toMatchObject({ kind: 'fill', sensitive: true, fieldName: 'pass' });
  });

  it('autocomplete=cc-number、验证码容器内的输入框同样标记敏感', () => {
    html(
      '<input id="c" name="x" autocomplete="cc-number">' +
        '<div class="g-recaptcha"><input id="d" name="y"></div>',
    );
    for (const id of ['#c', '#d']) {
      $<HTMLInputElement>(id).value = '123';
      change($(id));
    }
    expect(actions.map((a) => (a as { sensitive?: boolean }).sensitive)).toEqual([true, true]);
  });
});

describe('Enter / Escape', () => {
  it('Enter 先把未提交的输入 flush 成 fill，再记录 press', () => {
    html('<form><input id="q" name="q"></form>');
    const input = $<HTMLInputElement>('#q');
    input.value = 'hello';
    keydown(input, 'Enter');
    expect(actions.map((a) => a.kind)).toEqual(['fill', 'press']);
    expect(actions[0]).toMatchObject({ value: 'hello' });
    expect(actions[1]).toMatchObject({ key: 'Enter' });
  });

  it('Enter 之后浏览器补发的 change 不会重复记录 fill', () => {
    html('<input id="q" name="q">');
    const input = $<HTMLInputElement>('#q');
    input.value = 'hello';
    keydown(input, 'Enter');
    change(input);
    expect(actions.map((a) => a.kind)).toEqual(['fill', 'press']);
  });

  it('先 change 记录过 fill，再按 Enter 只记录 press', () => {
    html('<input id="q" name="q">');
    const input = $<HTMLInputElement>('#q');
    input.value = 'hello';
    change(input);
    keydown(input, 'Enter');
    expect(actions.map((a) => a.kind)).toEqual(['fill', 'press']);
  });

  it('Enter 在 textarea 里是换行，不记录任何内容', () => {
    html('<textarea id="t"></textarea>');
    $<HTMLTextAreaElement>('#t').value = 'a';
    keydown($('#t'), 'Enter');
    expect(actions).toEqual([]);
  });

  it('Escape 记录 press，在文本框内同样先 flush fill', () => {
    html('<input id="q" name="q">');
    const input = $<HTMLInputElement>('#q');
    input.value = 'x';
    keydown(input, 'Escape');
    expect(actions.map((a) => a.kind)).toEqual(['fill', 'press']);
    expect(actions[1]).toMatchObject({ key: 'Escape' });
  });

  it('其他按键不记录', () => {
    html('<input id="q">');
    keydown($('#q'), 'a');
    keydown($('#q'), 'Tab');
    expect(actions).toEqual([]);
  });

  it('在按钮上按 Enter 只记录 press', () => {
    html('<button id="b">x</button>');
    keydown($('#b'), 'Enter');
    expect(actions.map((a) => a.kind)).toEqual(['press']);
  });
});

describe('勾选与下拉', () => {
  it('复选框 change 记录 check 及勾选状态', () => {
    html('<input id="c" type="checkbox" name="agree">');
    const c = $<HTMLInputElement>('#c');
    c.checked = true;
    change(c);
    c.checked = false;
    change(c);
    expect(actions).toMatchObject([
      { kind: 'check', checked: true },
      { kind: 'check', checked: false },
    ]);
  });

  it('单选框记录 check', () => {
    html('<input id="r" type="radio" name="sex">');
    const r = $<HTMLInputElement>('#r');
    r.checked = true;
    change(r);
    expect(actions).toMatchObject([{ kind: 'check', checked: true }]);
  });

  it('下拉框 change 记录 select 及选中值', () => {
    html('<select id="s"><option value="a">A</option><option value="b">B</option></select>');
    const s = $<HTMLSelectElement>('#s');
    s.value = 'b';
    change(s);
    expect(actions).toMatchObject([{ kind: 'select', value: 'b' }]);
    const a = actions[0] as Extract<RecordedAction, { kind: 'select' }>;
    expect(resolve(a.locator).element).toBe(s);
  });

  it('change 事件发生在无关元素上不记录', () => {
    html('<div id="d"></div><input type="file" id="f">');
    change($('#d'));
    change($('#f'));
    expect(actions).toEqual([]);
  });
});

describe('isTrusted 与生命周期', () => {
  it('非受信（脚本派发）事件被忽略——recorder 依赖 isTrusted 区分用户操作与页面脚本', () => {
    html('<button id="b">x</button><input id="i" name="i"><input id="c" type="checkbox">');
    $('#b').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    $<HTMLInputElement>('#i').value = 'v';
    $('#i').dispatchEvent(new Event('change', { bubbles: true }));
    $('#i').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    $('#c').dispatchEvent(new Event('change', { bubbles: true }));
    expect(actions).toEqual([]);
  });

  it('stop 之后不再记录，重新 start 后恢复', () => {
    html('<button id="b">x</button>');
    recorder.stop();
    click($('#b'));
    expect(actions).toEqual([]);
    recorder.start();
    click($('#b'));
    expect(actions).toHaveLength(1);
  });

  it('重复 start 不会重复注册监听器', () => {
    html('<button id="b">x</button>');
    recorder.start();
    recorder.start();
    click($('#b'));
    expect(actions).toHaveLength(1);
  });
});
