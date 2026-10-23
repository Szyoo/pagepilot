import type { CaptureElement } from '../../schema/message';
import {
  generateLocator,
  isSensitive,
  isVisible,
  nameOf,
  roleOf,
  withLocatorCache,
} from '../selector';

const INTERACTIVE =
  'input, select, textarea, button, a[href], [role="button"], [role="link"], [role="checkbox"], ' +
  '[role="radio"], [role="tab"], [role="menuitem"], [role="combobox"], [contenteditable=""], ' +
  '[contenteditable="true"], [data-testid], [data-test-id], [data-qa]';

const SAFE_ATTRS = [
  'id',
  'name',
  'type',
  'role',
  'placeholder',
  'href',
  'aria-label',
  'autocomplete',
  'for',
  'data-testid',
  'data-test-id',
  'data-qa',
  'disabled',
  'required',
];
/** 敏感字段只保留这些非取值类属性 */
const SENSITIVE_ATTRS = ['type', 'name', 'id', 'role', 'autocomplete'];

const MAX_ELEMENTS = 500;

/** 链接只保留路径，避免把查询串里的令牌带出去 */
function safeHref(href: string): string {
  try {
    const u = new URL(href, location.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

export function captureElements(): CaptureElement[] {
  return withLocatorCache(collect);
}

function collect(): CaptureElement[] {
  const out: CaptureElement[] = [];
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (out.length >= MAX_ELEMENTS) break;
    if (!isVisible(el)) continue;
    const sensitive = isSensitive(el);
    const attrs: Record<string, string> = {};
    for (const a of sensitive ? SENSITIVE_ATTRS : SAFE_ATTRS) {
      const v = el.getAttribute(a);
      if (v !== null) attrs[a] = a === 'href' ? safeHref(v) : v.slice(0, 200);
    }
    const role = roleOf(el);
    const name = sensitive ? undefined : nameOf(el).slice(0, 120) || undefined;
    const text = sensitive
      ? undefined
      : (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
    out.push({
      tag: el.tagName.toLowerCase(),
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(text ? { text } : {}),
      attrs,
      locator: generateLocator(el),
      sensitive,
    });
  }
  return out;
}
