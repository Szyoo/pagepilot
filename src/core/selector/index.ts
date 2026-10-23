import type { Locator } from '../../schema/rule';
import { isElement, isIframe, isImage, isInput, isSelect, isTextarea } from './dom';

type Strategy = Locator['strategies'][number];

const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-qa', 'data-cy'];

const IMPLICIT_ROLE: Record<string, string> = {
  a: 'link',
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  summary: 'button',
  option: 'option',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  img: 'img',
};

const INPUT_ROLE: Record<string, string> = {
  checkbox: 'checkbox',
  radio: 'radio',
  button: 'button',
  submit: 'button',
  reset: 'button',
  range: 'slider',
  search: 'searchbox',
  email: 'textbox',
  text: 'textbox',
  tel: 'textbox',
  url: 'textbox',
  number: 'spinbutton',
  password: 'textbox',
};

export function roleOf(el: Element): string | undefined {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.split(' ')[0];
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') return INPUT_ROLE[(el as HTMLInputElement).type] ?? 'textbox';
  return IMPLICIT_ROLE[tag];
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** 可访问名称（近似实现） */
export function nameOf(el: Element): string {
  const label = clean(el.getAttribute('aria-label'));
  if (label) return label;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => clean(el.ownerDocument.getElementById(id)?.textContent))
      .join(' ')
      .trim();
    if (text) return text;
  }
  if (isInput(el) || isTextarea(el) || isSelect(el)) {
    const labels = el.labels ? Array.from(el.labels).map((l) => clean(l.textContent)) : [];
    const text = labels.join(' ').trim();
    if (text) return text;
    if (isInput(el) && ['button', 'submit', 'reset'].includes(el.type)) {
      return clean(el.value);
    }
    const ph = clean(el.getAttribute('placeholder'));
    if (ph) return ph;
  }
  if (isImage(el)) return clean(el.alt);
  const text = clean(el.textContent);
  if (text && text.length <= 80) return text;
  return clean(el.getAttribute('title'));
}

export function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  return style.visibility !== 'hidden' && style.display !== 'none';
}

const cssEscape = (s: string) => CSS.escape(s);

function queryAll(doc: Document, strategy: Strategy): Element[] {
  const { kind, value } = strategy;
  try {
    switch (kind) {
      case 'css':
        return Array.from(doc.querySelectorAll(value));
      case 'testid': {
        const q = TESTID_ATTRS.map((a) => `[${a}="${CSS.escape(value)}"]`).join(',');
        return Array.from(doc.querySelectorAll(q));
      }
      case 'xpath': {
        const snap = doc.evaluate(value, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const out: Element[] = [];
        for (let i = 0; i < snap.snapshotLength; i++) {
          const n = snap.snapshotItem(i);
          if (isElement(n)) out.push(n);
        }
        return out;
      }
      case 'text': {
        const want = clean(value);
        const out: Element[] = [];
        for (const el of doc.querySelectorAll('body *')) {
          const own = clean(
            Array.from(el.childNodes)
              .filter((n) => n.nodeType === Node.TEXT_NODE)
              .map((n) => n.textContent)
              .join(' '),
          );
          if (own === want) out.push(el);
        }
        return out;
      }
      case 'aria': {
        const m = /^([a-z]+)(?:\[name="((?:[^"\\]|\\.)*)"\])?$/.exec(value);
        if (!m?.[1]) return [];
        const role = m[1];
        const name = m[2]?.replace(/\\(.)/g, '$1');
        return Array.from(doc.querySelectorAll('*')).filter(
          (el) => roleOf(el) === role && (name === undefined || nameOf(el) === name),
        );
      }
    }
  } catch {
    return [];
  }
}

export interface Resolved {
  /** crossOrigin：定位链经过无法访问的 iframe */
  crossOrigin: boolean;
  element: Element | null;
  /** 命中的策略下的匹配数量（未命中为 0，多于 1 视为未命中） */
  count: number;
  /** 元素所在文档相对当前 frame 视口的偏移（经过的同源 iframe 累计） */
  offset: { x: number; y: number };
}

/** 沿 locator.frame 进入同源 iframe；经过跨域 iframe 时返回 crossOrigin */
function enterFrames(
  locator: Locator,
  ignoreFrame: boolean,
): { doc: Document; offset: { x: number; y: number } } | 'crossOrigin' | null {
  let doc = document;
  const offset = { x: 0, y: 0 };
  if (ignoreFrame) return { doc, offset };
  for (const sel of locator.frame ?? []) {
    const frame = doc.querySelector(sel);
    if (!isIframe(frame)) return null;
    let inner: Document | null = null;
    try {
      inner = frame.contentDocument;
    } catch {
      inner = null;
    }
    if (!inner) return 'crossOrigin';
    const r = frame.getBoundingClientRect();
    offset.x += r.left + frame.clientLeft;
    offset.y += r.top + frame.clientTop;
    doc = inner;
  }
  return { doc, offset };
}

/** 按顺序尝试各策略，第一个唯一命中的生效 */
export function resolve(locator: Locator, ignoreFrame = false): Resolved {
  const entered = enterFrames(locator, ignoreFrame);
  if (entered === 'crossOrigin') {
    return { crossOrigin: true, element: null, count: 0, offset: { x: 0, y: 0 } };
  }
  if (!entered) return { crossOrigin: false, element: null, count: 0, offset: { x: 0, y: 0 } };
  for (const strategy of locator.strategies) {
    const found = queryAll(entered.doc, strategy);
    if (found.length === 1 && found[0]) {
      return { crossOrigin: false, element: found[0], count: 1, offset: entered.offset };
    }
  }
  return { crossOrigin: false, element: null, count: 0, offset: entered.offset };
}

// ---- 生成 ----

const unstableId = (id: string) =>
  /\d{4,}|^[0-9a-f]{8,}$|^:r|^radix-|^ember|^react-|^headlessui/i.test(id);
const unstableClass = (c: string) => /\d{3,}|^css-|^jss|^sc-|^_|^[a-z]{1,2}[A-Z0-9]\w{5,}$/.test(c);

function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === Node.ELEMENT_NODE && cur !== cur.ownerDocument.documentElement) {
    const tag = cur.tagName.toLowerCase();
    if (cur.id && !unstableId(cur.id)) {
      parts.unshift(`#${cssEscape(cur.id)}`);
      break;
    }
    const classes = Array.from(cur.classList)
      .filter((c) => !unstableClass(c))
      .slice(0, 2);
    let part = tag + classes.map((c) => `.${cssEscape(c)}`).join('');
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.matches(part));
      if (same.length > 1)
        part += `:nth-of-type(${
          Array.from(parent.children)
            .filter((c) => c.tagName === cur?.tagName)
            .indexOf(cur) + 1
        })`;
    }
    parts.unshift(part);
    cur = parent;
    if (parts.length >= 5) break;
  }
  return parts.join(' > ');
}

function xpathOf(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    const tag = cur.tagName.toLowerCase();
    const parent: Element | null = cur.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const same = Array.from(parent.children).filter((c) => c.tagName === cur?.tagName);
    parts.unshift(same.length > 1 ? `${tag}[${same.indexOf(cur) + 1}]` : tag);
    cur = parent;
  }
  return `/${parts.join('/')}`;
}

/** 当前元素所在 iframe 的选择器链（跨域时退化为按 src 的猜测选择器） */
function frameChain(): string[] | undefined {
  if (window === window.top) return undefined;
  const chain: string[] = [];
  let win: Window = window;
  while (win !== win.top) {
    let frameEl: Element | null = null;
    try {
      frameEl = win.frameElement;
    } catch {
      frameEl = null;
    }
    if (!frameEl) {
      // 跨域：只能用 src 的来源做猜测
      try {
        chain.unshift(`iframe[src*="${new URL(location.href).hostname}"]`);
      } catch {
        chain.unshift('iframe');
      }
      return chain;
    }
    chain.unshift(cssPath(frameEl));
    const parent: Window = win.parent;
    win = parent;
  }
  return chain;
}

/** 生成多条定位策略，稳定性从高到低 */
export function generateLocator(el: Element): Locator {
  const strategies: Strategy[] = [];
  const doc = el.ownerDocument;
  const unique = (s: Strategy) => queryAll(doc, s).length === 1;
  const push = (s: Strategy) => {
    if (unique(s) && !strategies.some((x) => x.kind === s.kind && x.value === s.value)) {
      strategies.push(s);
    }
  };

  for (const attr of TESTID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) push({ kind: 'testid', value: v });
  }
  if (el.id && !unstableId(el.id)) push({ kind: 'css', value: `#${cssEscape(el.id)}` });
  const nameAttr = el.getAttribute('name');
  if (nameAttr) {
    push({
      kind: 'css',
      value: `${el.tagName.toLowerCase()}[name="${CSS.escape(nameAttr)}"]`,
    });
  }
  const role = roleOf(el);
  const name = nameOf(el);
  if (role && name && name.length <= 60) {
    push({ kind: 'aria', value: `${role}[name="${name.replace(/(["\\])/g, '\\$1')}"]` });
  }
  push({ kind: 'css', value: cssPath(el) });
  const own = clean(
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent)
      .join(' '),
  );
  if (own && own.length <= 40) push({ kind: 'text', value: own });
  strategies.push({ kind: 'xpath', value: xpathOf(el) });

  const frame = frameChain();
  return frame ? { strategies, frame } : { strategies };
}

// ---- 敏感字段 ----

/** 按词判断，避免 passenger、discard 这类词被误判 */
const SENSITIVE_WORDS = new Set([
  'pass',
  'passwd',
  'password',
  'passcode',
  'pwd',
  'card',
  'cardnumber',
  'creditcard',
  'ccnumber',
  'cvv',
  'cvc',
  'cvn',
  'csc',
  'otp',
  'token',
  'secret',
  'pin',
  'iban',
  'ssn',
]);
const SENSITIVE_PREFIXES = ['captcha', 'verif', 'password'];

function sensitiveName(hint: string): boolean {
  const words = hint
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some(
    (w) => SENSITIVE_WORDS.has(w) || SENSITIVE_PREFIXES.some((p) => w.startsWith(p)),
  );
}
const SENSITIVE_AUTOCOMPLETE = /password|cc-|one-time-code/i;

/** 密码框、支付字段、验证码输入框等：不采集值 */
export function isSensitive(el: Element): boolean {
  if (isInput(el) && el.type === 'password') return true;
  const ac = el.getAttribute('autocomplete') ?? '';
  if (SENSITIVE_AUTOCOMPLETE.test(ac)) return true;
  const hint = `${el.getAttribute('name') ?? ''} ${el.id} ${el.getAttribute('aria-label') ?? ''}`;
  if (isInput(el) || isTextarea(el)) {
    if (sensitiveName(hint)) return true;
  }
  return Boolean(
    el.closest('[class*="captcha" i],[id*="captcha" i],.g-recaptcha,.h-captcha,.cf-turnstile'),
  );
}
