import type { CaptureElement } from '../../schema/message';
import type { InspectElement } from '../../shared/content-api';
import {
  generateLocator,
  isSensitive,
  isVisible,
  nameOf,
  roleOf,
  withLocatorCache,
} from '../selector';
import { isInput, isSelect, isTextarea } from '../selector/dom';

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

/** 页面概要最多的元素个数与每个元素文字的长度 */
export const INSPECT_MAX_ELEMENTS = 120;
export const INSPECT_MAX_TEXT = 60;

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function isEditable(el: Element): boolean {
  if (isInput(el) || isTextarea(el) || isSelect(el)) return true;
  if ((el as HTMLElement).isContentEditable === true) return true;
  const ce = el.getAttribute('contenteditable');
  return ce !== null && ce.toLowerCase() !== 'false';
}

/**
 * 输入类元素的名称：只取标签、aria-label、placeholder、title，
 * 不取 value 与 textContent（文本框、可编辑区域的内容可能是用户输入）。按钮类 input 的 value 是按钮文字
 */
function fieldName(el: Element): string {
  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = clean(
      by
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
        .join(' '),
    );
    if (text) return text;
  }
  if (isInput(el) || isTextarea(el) || isSelect(el)) {
    const labels = el.labels ? Array.from(el.labels).map((l) => clean(l.textContent)) : [];
    const text = clean(labels.join(' '));
    if (text) return text;
    if (isInput(el) && ['button', 'submit', 'reset'].includes(el.type)) return clean(el.value);
  }
  return clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title'));
}

/**
 * 「请 AI 看看」用的页面概要：可见的交互元素，每个只保留标签名、角色、名称或文字（截断）与敏感标记。
 * 不带属性、定位器与输入值，敏感元素不带文字。只在本机使用，不上报后台
 */
export function inspectElements(max = INSPECT_MAX_ELEMENTS): InspectElement[] {
  return withLocatorCache(() => {
    const out: InspectElement[] = [];
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (out.length >= max) break;
      if (!isVisible(el)) continue;
      const sensitive = isSensitive(el);
      const role = roleOf(el);
      let text: string | undefined;
      if (!sensitive) {
        const raw = isEditable(el) ? fieldName(el) : nameOf(el) || clean(el.textContent);
        text = raw.slice(0, INSPECT_MAX_TEXT) || undefined;
      }
      out.push({
        tag: el.tagName.toLowerCase(),
        ...(role ? { role } : {}),
        ...(text ? { text } : {}),
        sensitive,
      });
    }
    return out;
  });
}
