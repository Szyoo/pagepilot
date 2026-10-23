import { vi } from 'vitest';

/** jsdom 没有布局：getBoundingClientRect 恒为 0，isVisible 恒为 false */
const hiddenByAncestor = (el: Element): boolean => {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (cur instanceof HTMLElement && (cur.hidden || cur.style.display === 'none')) return true;
  }
  return false;
};

/**
 * 让可见元素拥有非零矩形（100x20，左上角 0,0）。
 * 自身或祖先 display:none / hidden 的元素仍返回零矩形，贴近真实浏览器的表现。
 */
export function mockLayout(rect: { left?: number; top?: number } = {}) {
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    const zero = hiddenByAncestor(this);
    const left = rect.left ?? 0;
    const top = rect.top ?? 0;
    const width = zero ? 0 : 100;
    const height = zero ? 0 : 20;
    return {
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

/** jsdom 未实现 scrollIntoView */
export function stubScrollIntoView() {
  const fn = vi.fn();
  Element.prototype.scrollIntoView = fn as unknown as Element['scrollIntoView'];
  return fn;
}

const trustedEvents = new WeakSet<Event>();

/**
 * 标记一个事件为“用户触发”。
 * jsdom 的 isTrusted 是不可配置的实例属性，无法用 Object.defineProperty 改写，
 * 所以配合 installTrustBridge()：被标记的事件在到达 document 上的监听器时，
 * 由代理对象把 isTrusted 报告为 true，其余行为透传。
 */
export function trusted<T extends Event>(event: T): T {
  trustedEvents.add(event);
  return event;
}

/** 在 document 上注册的监听器收到“被标记为 trusted”的事件代理；调用 vi.restoreAllMocks() 还原 */
export function installTrustBridge() {
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const wrappers = new WeakMap<object, EventListener>();
  const wrap = (fn: EventListener): EventListener => {
    let w = wrappers.get(fn);
    if (!w) {
      w = (ev: Event) => {
        if (!trustedEvents.has(ev)) return fn(ev);
        const proxy = new Proxy(ev, {
          get(target, prop) {
            if (prop === 'isTrusted') return true;
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return fn(proxy);
      };
      wrappers.set(fn, w);
    }
    return w;
  };
  vi.spyOn(document, 'addEventListener').mockImplementation(function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (typeof listener === 'function') return add.call(this, type, wrap(listener), options);
    return add.call(this, type, listener, options);
  } as typeof document.addEventListener);
  vi.spyOn(document, 'removeEventListener').mockImplementation(function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    if (typeof listener === 'function') return remove.call(this, type, wrap(listener), options);
    return remove.call(this, type, listener, options);
  } as typeof document.removeEventListener);
}

export function html(markup: string): void {
  document.body.innerHTML = markup;
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`找不到元素：${sel}`);
  return el;
};

/**
 * vitest 的 jsdom 环境里全局 `window` 是 Node 的 globalThis，而不是 jsdom 的 Window，
 * 构造 `new MouseEvent(..., { view: window })` 会报 "member view is not of type Window"。
 * 把 `window` 换成 vitest 暴露的 jsdom 真实 Window（globalThis.jsdom.window）后与真实浏览器一致；用完调用 vi.unstubAllGlobals()。
 */
export function useJsdomWindow() {
  vi.stubGlobal('window', (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window);
}
