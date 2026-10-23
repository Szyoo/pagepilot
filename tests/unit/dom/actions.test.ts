// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { frameOffsetByUrl, performAct, prepareTarget } from '../../../src/core/player/actions';
import type { Locator } from '../../../src/schema/rule';
import { $, html, mockLayout, stubScrollIntoView, useJsdomWindow } from '../../helpers/dom';

const at = (selector: string): Locator => ({ strategies: [{ kind: 'css', value: selector }] });

function record(el: Element, types: string[]) {
  const log: string[] = [];
  for (const t of types) el.addEventListener(t, () => log.push(t));
  return log;
}

beforeEach(() => {
  html('');
  stubScrollIntoView();
  mockLayout();
  useJsdomWindow();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('performAct 通用行为', () => {
  it('目标不存在返回 TARGET_NOT_FOUND', () => {
    expect(performAct({ action: 'click' }, at('#nope'), false)).toEqual({
      ok: false,
      code: 'TARGET_NOT_FOUND',
    });
  });

  it('目标命中多个元素同样视为不存在', () => {
    html('<button class="b"></button><button class="b"></button>');
    expect(performAct({ action: 'click' }, at('.b'), false)).toMatchObject({
      ok: false,
      code: 'TARGET_NOT_FOUND',
    });
  });

  it('内部异常被转换为 INTERNAL 而不是抛出', () => {
    html('<button id="b"></button>');
    Element.prototype.scrollIntoView = () => {
      throw new Error('boom');
    };
    expect(performAct({ action: 'click' }, at('#b'), false)).toEqual({
      ok: false,
      code: 'INTERNAL',
      message: 'boom',
    });
  });
});

describe('click', () => {
  it('依次派发 pointerdown、mousedown、pointerup、mouseup、click 并聚焦', () => {
    html('<button id="b">x</button>');
    const b = $('#b');
    const log = record(b, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'focus']);
    expect(performAct({ action: 'click' }, at('#b'), false)).toEqual({ ok: true });
    expect(log).toEqual(['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']);
    expect(document.activeElement).toBe(b);
  });

  it('事件坐标位于元素中心，且冒泡', () => {
    html('<div id="wrap"><button id="b">x</button></div>');
    mockLayout({ left: 10, top: 20 }); // 100x20 的矩形，中心 (60, 30)
    let seen: MouseEvent | undefined;
    $('#wrap').addEventListener('click', (e) => {
      seen = e as MouseEvent;
    });
    performAct({ action: 'click' }, at('#b'), false);
    expect(seen).toMatchObject({ clientX: 60, clientY: 30, button: 0 });
  });

  it('点击前把元素滚动到视口中央', () => {
    html('<button id="b"></button>');
    const spy = stubScrollIntoView();
    performAct({ action: 'click' }, at('#b'), false);
    expect(spy).toHaveBeenCalledWith({ block: 'center', inline: 'center' });
  });

  it('点击链接/提交按钮会触发其默认行为（提交表单）', () => {
    html('<form id="f"><button id="b" type="submit">go</button></form>');
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    $('#f').addEventListener('submit', onSubmit);
    performAct({ action: 'click' }, at('#b'), false);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('fill', () => {
  it('设置值并依次触发 input、change 事件', () => {
    html('<input id="i" value="旧">');
    const i = $<HTMLInputElement>('#i');
    const log = record(i, ['input', 'change']);
    expect(performAct({ action: 'fill', value: '新值', clear: true }, at('#i'), false)).toEqual({
      ok: true,
    });
    expect(i.value).toBe('新值');
    expect(log).toEqual(['input', 'change']);
  });

  it('clear=false 时追加到现有值之后', () => {
    html('<input id="i" value="abc">');
    performAct({ action: 'fill', value: 'def', clear: false }, at('#i'), false);
    expect($<HTMLInputElement>('#i').value).toBe('abcdef');
  });

  it('textarea 同样适用', () => {
    html('<textarea id="t"></textarea>');
    performAct({ action: 'fill', value: '多行\n文本', clear: true }, at('#t'), false);
    expect($<HTMLTextAreaElement>('#t').value).toBe('多行\n文本');
  });

  it('用原生 setter 赋值，绕过 React 等框架挂在实例上的 value 追踪', () => {
    html('<input id="i">');
    const i = $<HTMLInputElement>('#i');
    const proto = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    ) as PropertyDescriptor;
    const tracked = vi.fn();
    Object.defineProperty(i, 'value', {
      configurable: true,
      get: () => proto.get?.call(i),
      set: (v: string) => {
        tracked(v);
        proto.set?.call(i, v);
      },
    });
    performAct({ action: 'fill', value: 'x', clear: true }, at('#i'), false);
    expect(tracked).not.toHaveBeenCalled();
    expect(proto.get?.call(i)).toBe('x');
  });

  it('聚焦目标输入框', () => {
    html('<input id="i">');
    performAct({ action: 'fill', value: 'x', clear: true }, at('#i'), false);
    expect(document.activeElement).toBe($('#i'));
  });

  it('contenteditable 元素写入 textContent 并触发 input', () => {
    html('<div id="c"></div>');
    const c = $('#c');
    Object.defineProperty(c, 'isContentEditable', { value: true }); // jsdom 未实现该属性
    const log = record(c, ['input']);
    performAct({ action: 'fill', value: '内容', clear: true }, at('#c'), false);
    expect(c.textContent).toBe('内容');
    expect(log).toEqual(['input']);
  });

  it('目标不可输入时返回 INTERNAL', () => {
    html('<div id="d">x</div>');
    expect(performAct({ action: 'fill', value: 'x', clear: true }, at('#d'), false)).toMatchObject({
      ok: false,
      code: 'INTERNAL',
    });
  });
});

describe('同源 iframe 内的元素（由顶层 frame 直接操作）', () => {
  // 已知问题：actions 里用顶层 realm 的 HTMLInputElement 做 instanceof，
  // 子 frame 文档里的 input 属于另一个 realm，被判定为“目标不可输入”。修复后应改回 it。
  it('fill 能写入 iframe 内的输入框', () => {
    html('<iframe id="f"></iframe>');
    const inner = $<HTMLIFrameElement>('#f').contentDocument as Document;
    inner.body.innerHTML = '<input id="i">';
    const input = inner.getElementById('i') as HTMLInputElement;
    input.scrollIntoView = vi.fn();
    const res = performAct(
      { action: 'fill', value: 'x', clear: true },
      { strategies: [{ kind: 'css', value: '#i' }], frame: ['#f'] },
      false,
    );
    expect(res).toEqual({ ok: true });
    expect(input.value).toBe('x');
  });
});

describe('select', () => {
  beforeEach(() =>
    html(
      '<select id="s"><option value="a">选项 A</option><option value="b"> 选项 B </option></select>',
    ),
  );

  it('按 value 选择并触发 input、change', () => {
    const s = $<HTMLSelectElement>('#s');
    const log = record(s, ['input', 'change']);
    expect(performAct({ action: 'select', value: 'b' }, at('#s'), false)).toEqual({ ok: true });
    expect(s.value).toBe('b');
    expect(log).toEqual(['input', 'change']);
  });

  it('按显示文本选择（忽略首尾空白）', () => {
    performAct({ action: 'select', value: '选项 B' }, at('#s'), false);
    expect($<HTMLSelectElement>('#s').value).toBe('b');
  });

  it('value 优先于文本匹配', () => {
    html('<select id="s"><option value="x">b</option><option value="b">other</option></select>');
    performAct({ action: 'select', value: 'b' }, at('#s'), false);
    expect($<HTMLSelectElement>('#s').value).toBe('b');
  });

  it('没有该选项返回 TARGET_NOT_FOUND，且不改变选择', () => {
    const before = $<HTMLSelectElement>('#s').value;
    expect(performAct({ action: 'select', value: 'zzz' }, at('#s'), false)).toMatchObject({
      ok: false,
      code: 'TARGET_NOT_FOUND',
    });
    expect($<HTMLSelectElement>('#s').value).toBe(before);
  });

  it('目标不是下拉框返回 INTERNAL', () => {
    html('<input id="i">');
    expect(performAct({ action: 'select', value: 'a' }, at('#i'), false)).toMatchObject({
      ok: false,
      code: 'INTERNAL',
    });
  });
});

describe('check', () => {
  it('状态不同时才点击，并真正切换勾选状态', () => {
    html('<input type="checkbox" id="c">');
    const c = $<HTMLInputElement>('#c');
    const log = record(c, ['click', 'change']);
    expect(performAct({ action: 'check', checked: true }, at('#c'), false)).toEqual({ ok: true });
    expect(c.checked).toBe(true);
    expect(log).toEqual(['click', 'change']);
  });

  it('状态已一致时不点击', () => {
    html('<input type="checkbox" id="c" checked>');
    const log = record($('#c'), ['click', 'change']);
    performAct({ action: 'check', checked: true }, at('#c'), false);
    expect(log).toEqual([]);
    expect($<HTMLInputElement>('#c').checked).toBe(true);
  });

  it('取消勾选', () => {
    html('<input type="checkbox" id="c" checked>');
    performAct({ action: 'check', checked: false }, at('#c'), false);
    expect($<HTMLInputElement>('#c').checked).toBe(false);
  });

  it('目标不是 input 返回 INTERNAL', () => {
    html('<div id="d"></div>');
    expect(performAct({ action: 'check', checked: true }, at('#d'), false)).toMatchObject({
      ok: false,
      code: 'INTERNAL',
    });
  });
});

describe('press', () => {
  it('在目标上依次派发 keydown、keypress、keyup', () => {
    html('<input id="i">');
    const log = record($('#i'), ['keydown', 'keypress', 'keyup']);
    expect(performAct({ action: 'press', key: 'Tab' }, at('#i'), false)).toEqual({ ok: true });
    expect(log).toEqual(['keydown', 'keypress', 'keyup']);
  });

  it('组合键解析修饰符与字符键', () => {
    html('<input id="i">');
    let ev: KeyboardEvent | undefined;
    $('#i').addEventListener('keydown', (e) => {
      ev = e as KeyboardEvent;
    });
    performAct({ action: 'press', key: 'Control+Shift+a' }, at('#i'), false);
    expect(ev).toMatchObject({
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
    });
  });

  it('命名按键使用对应的 key/code', () => {
    html('<input id="i">');
    let ev: KeyboardEvent | undefined;
    $('#i').addEventListener('keydown', (e) => {
      ev = e as KeyboardEvent;
    });
    performAct({ action: 'press', key: 'ArrowDown' }, at('#i'), false);
    expect(ev).toMatchObject({ key: 'ArrowDown', code: 'ArrowDown' });
  });

  it('没有 locator 时作用于当前聚焦元素', () => {
    html('<input id="i">');
    $<HTMLInputElement>('#i').focus();
    const log = record($('#i'), ['keydown']);
    expect(performAct({ action: 'press', key: 'Escape' }, undefined, false)).toEqual({ ok: true });
    expect(log).toEqual(['keydown']);
  });

  it('Enter 在表单内的输入框上触发 requestSubmit', () => {
    html('<form id="f"><input id="i"></form>');
    const spy = vi
      .spyOn(HTMLFormElement.prototype, 'requestSubmit')
      .mockImplementation(() => undefined);
    performAct({ action: 'press', key: 'Enter' }, at('#i'), false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.contexts[0]).toBe($('#f'));
  });

  it('Enter 在表单外的输入框、或其他按键上不提交', () => {
    html('<input id="a"><form><input id="b"></form>');
    const spy = vi
      .spyOn(HTMLFormElement.prototype, 'requestSubmit')
      .mockImplementation(() => undefined);
    performAct({ action: 'press', key: 'Enter' }, at('#a'), false);
    performAct({ action: 'press', key: 'Tab' }, at('#b'), false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('extract', () => {
  it('attr 给出时取属性，属性不存在返回空串', () => {
    html('<a id="a" href="/x" data-id="42">link</a>');
    expect(performAct({ action: 'extract', attr: 'data-id' }, at('#a'), false)).toEqual({
      ok: true,
      value: '42',
    });
    expect(performAct({ action: 'extract', attr: 'data-none' }, at('#a'), false)).toEqual({
      ok: true,
      value: '',
    });
  });

  it('输入框、文本域、下拉框取当前值', () => {
    html(
      '<input id="i" value="v1"><textarea id="t">v2</textarea>' +
        '<select id="s"><option value="o1">一</option><option value="o2" selected>二</option></select>',
    );
    expect(performAct({ action: 'extract' }, at('#i'), false)).toMatchObject({ value: 'v1' });
    expect(performAct({ action: 'extract' }, at('#t'), false)).toMatchObject({ value: 'v2' });
    expect(performAct({ action: 'extract' }, at('#s'), false)).toMatchObject({ value: 'o2' });
  });

  it('其他元素取去除首尾空白的文本', () => {
    html('<div id="d">  订单号 123  </div>');
    expect(performAct({ action: 'extract' }, at('#d'), false)).toEqual({
      ok: true,
      value: '订单号 123',
    });
  });
});

describe('prepareTarget（trusted 模式准备）', () => {
  it('返回元素中心点（含 iframe 偏移）与标签', () => {
    html('<div><iframe id="f"></iframe></div>');
    const frame = $<HTMLIFrameElement>('#f');
    const inner = frame.contentDocument as Document;
    inner.body.innerHTML = '<button id="b">x</button>';
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ left: 30, top: 40 } as DOMRect);
    // 内部元素的矩形：left/top 为 5/6，宽高 100x20
    vi.spyOn(inner.getElementById('b') as Element, 'getBoundingClientRect').mockReturnValue({
      left: 5,
      top: 6,
      width: 100,
      height: 20,
    } as DOMRect);
    (inner.getElementById('b') as Element).scrollIntoView = vi.fn(); // 子 frame 的 Element 原型同样没有该方法
    const res = prepareTarget(
      { strategies: [{ kind: 'css', value: '#b' }], frame: ['#f'] },
      false,
      false,
      false,
    );
    expect(res).toEqual({ ok: true, x: 30 + 5 + 50, y: 40 + 6 + 10, tag: 'button' });
  });

  it('输入框带回 checked 状态，并按需聚焦与全选', () => {
    html('<input id="c" type="checkbox" checked><input id="i" value="hello">');
    const checkbox = prepareTarget(at('#c'), false, false, false);
    expect(checkbox).toMatchObject({ ok: true, tag: 'input', checked: true });
    const input = $<HTMLInputElement>('#i');
    const select = vi.spyOn(input, 'select');
    prepareTarget(at('#i'), false, true, true);
    expect(document.activeElement).toBe(input);
    expect(select).toHaveBeenCalled();
  });

  it('找不到目标返回 TARGET_NOT_FOUND', () => {
    expect(prepareTarget(at('#none'), false, false, false)).toEqual({
      ok: false,
      code: 'TARGET_NOT_FOUND',
    });
  });
});

describe('frameOffsetByUrl', () => {
  it('按 src 找到 iframe 并返回内容区左上角', () => {
    html('<iframe id="f" src="https://example.com/inner"></iframe>');
    const frame = $<HTMLIFrameElement>('#f');
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ left: 12, top: 34 } as DOMRect);
    expect(frameOffsetByUrl('https://example.com/inner')).toEqual({ x: 12, y: 34 });
    expect(frameOffsetByUrl('https://example.com/other')).toBeNull();
  });
});
