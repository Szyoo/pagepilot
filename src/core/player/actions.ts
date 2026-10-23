import type { Locator } from '../../schema/rule';
import type { Act, ActResult, PrepareResult } from '../../shared/content-api';
import { resolve } from '../selector';
import { isElement, isHtmlElement, isInput, isSelect, isTextarea } from '../selector/dom';

/** content 侧的页面操作：synthetic 模式直接执行，trusted 模式只做准备（滚动、聚焦、取坐标） */

function find(locator: Locator | undefined, ignoreFrame: boolean) {
  if (!locator) return { element: document.activeElement, offset: { x: 0, y: 0 } };
  const r = resolve(locator, ignoreFrame);
  return { element: r.element, offset: r.offset };
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  // 用元素所属 frame 的构造函数，同源 iframe 里的元素与顶层不是同一个 JS 环境
  const win = (el.ownerDocument.defaultView ?? window) as typeof window;
  const proto = isTextarea(el) ? win.HTMLTextAreaElement : win.HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function fire(el: Element, type: string, init: EventInit = {}) {
  el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
}

function mouseSequence(el: Element) {
  const r = el.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
    button: 0,
  };
  el.dispatchEvent(new PointerEvent('pointerdown', init));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  if (isHtmlElement(el)) el.focus({ preventScroll: true });
  el.dispatchEvent(new PointerEvent('pointerup', init));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.dispatchEvent(new MouseEvent('click', init));
}

const KEY_CODES: Record<string, { key: string; code: string }> = {
  Enter: { key: 'Enter', code: 'Enter' },
  Tab: { key: 'Tab', code: 'Tab' },
  Escape: { key: 'Escape', code: 'Escape' },
  Backspace: { key: 'Backspace', code: 'Backspace' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft' },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight' },
  Space: { key: ' ', code: 'Space' },
};

function press(target: Element | null, combo: string) {
  const el = target ?? document.activeElement ?? document.body;
  const parts = combo.split('+');
  const main = parts.pop() ?? '';
  const mods = parts.map((p) => p.toLowerCase());
  const def = KEY_CODES[main] ?? {
    key: main,
    code: main.length === 1 ? `Key${main.toUpperCase()}` : main,
  };
  const init = {
    key: def.key,
    code: def.code,
    bubbles: true,
    cancelable: true,
    ctrlKey: mods.includes('control') || mods.includes('ctrl'),
    shiftKey: mods.includes('shift'),
    altKey: mods.includes('alt'),
    metaKey: mods.includes('meta') || mods.includes('cmd'),
  };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  if (main === 'Enter' && isInput(el) && el.form) {
    el.form.requestSubmit();
  }
}

function pickOption(el: HTMLSelectElement, want: string): HTMLOptionElement | undefined {
  const opts = Array.from(el.options);
  return opts.find((o) => o.value === want) ?? opts.find((o) => o.text.trim() === want.trim());
}

export function performAct(
  act: Act,
  locator: Locator | undefined,
  ignoreFrame: boolean,
): ActResult {
  const { element: el } = find(locator, ignoreFrame);
  if (!el) return { ok: false, code: 'TARGET_NOT_FOUND' };
  try {
    switch (act.action) {
      case 'click':
        el.scrollIntoView({ block: 'center', inline: 'center' });
        mouseSequence(el);
        return { ok: true };
      case 'fill': {
        el.scrollIntoView({ block: 'center' });
        if (isHtmlElement(el)) el.focus({ preventScroll: true });
        if (isInput(el) || isTextarea(el)) {
          setNativeValue(el, act.clear ? act.value : el.value + act.value);
          fire(el, 'input');
          fire(el, 'change');
        } else if (isHtmlElement(el) && el.isContentEditable) {
          el.textContent = act.clear ? act.value : (el.textContent ?? '') + act.value;
          fire(el, 'input');
        } else return { ok: false, code: 'INTERNAL', message: '目标不可输入' };
        return { ok: true };
      }
      case 'select': {
        if (!isSelect(el)) return { ok: false, code: 'INTERNAL', message: '目标不是下拉框' };
        const opt = pickOption(el, act.value);
        if (!opt) return { ok: false, code: 'TARGET_NOT_FOUND', message: '没有该选项' };
        el.value = opt.value;
        fire(el, 'input');
        fire(el, 'change');
        return { ok: true };
      }
      case 'check': {
        if (!isInput(el)) return { ok: false, code: 'INTERNAL', message: '目标不是勾选框' };
        if (el.checked !== act.checked) {
          el.scrollIntoView({ block: 'center' });
          mouseSequence(el);
        }
        return { ok: true };
      }
      case 'press':
        press(locator ? el : null, act.key);
        return { ok: true };
      case 'extract': {
        if (act.attr) return { ok: true, value: el.getAttribute(act.attr) ?? '' };
        if (isInput(el) || isTextarea(el) || isSelect(el)) {
          return { ok: true, value: el.value };
        }
        return { ok: true, value: ((el as HTMLElement).innerText ?? el.textContent ?? '').trim() };
      }
    }
  } catch (e) {
    return { ok: false, code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) };
  }
}

/** trusted 模式：把元素滚动到可见、聚焦，并返回中心点（相对本 frame 视口，含同源 iframe 偏移） */
export function prepareTarget(
  locator: Locator,
  ignoreFrame: boolean,
  focus: boolean,
  selectContent: boolean,
): PrepareResult {
  const { element: el, offset } = find(locator, ignoreFrame);
  if (!el) return { ok: false, code: 'TARGET_NOT_FOUND' };
  try {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (focus && isHtmlElement(el)) el.focus({ preventScroll: true });
    if (selectContent) {
      if (isInput(el) || isTextarea(el)) el.select();
      else if (isHtmlElement(el) && el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
    const r = el.getBoundingClientRect();
    return {
      ok: true,
      x: offset.x + r.left + r.width / 2,
      y: offset.y + r.top + r.height / 2,
      tag: el.tagName.toLowerCase(),
      ...(isInput(el) ? { checked: el.checked } : {}),
    };
  } catch {
    return { ok: false, code: 'INTERNAL' };
  }
}

/** 本文档里 src 与给定 URL 相同的 iframe 的内容区左上角（相对视口） */
export function frameOffsetByUrl(url: string): { x: number; y: number } | null {
  for (const f of document.querySelectorAll('iframe')) {
    if (f.src === url || f.contentWindow?.location.href === url) {
      const r = f.getBoundingClientRect();
      return { x: r.left + f.clientLeft, y: r.top + f.clientTop };
    }
  }
  return null;
}
