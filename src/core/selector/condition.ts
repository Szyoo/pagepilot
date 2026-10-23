import type { Condition } from '../../schema/rule';
import { matchesGlob } from '../../shared/glob';
import { isInput, isTextarea } from './dom';
import { isVisible, resolve } from './index';

function textOf(el: Element): string {
  if (isInput(el) || isTextarea(el)) {
    return el.value || el.textContent || '';
  }
  return (el as HTMLElement).innerText ?? el.textContent ?? '';
}

/** 输入框已填满：有 maxlength 时长度达到它，否则只要非空 */
function isFilled(el: Element): boolean {
  if (!isInput(el) && !isTextarea(el)) return false;
  const max = el.maxLength;
  return max > 0 ? el.value.length >= max : el.value.length > 0;
}

function hasMinLength(el: Element, min: number): boolean {
  return (isInput(el) || isTextarea(el)) && el.value.length >= min;
}

/**
 * 在当前 frame 内判断条件。
 * 经过跨域 iframe 的元素条件视为不成立。
 */
export function evaluateCondition(c: Condition): boolean {
  switch (c.kind) {
    case 'url':
      return matchesGlob(c.pattern, location.href);
    case 'not':
      return !evaluateCondition(c.condition);
    case 'all':
      return c.conditions.every(evaluateCondition);
    case 'any':
      return c.conditions.some(evaluateCondition);
    case 'element': {
      const { element } = resolve(c.target);
      if (!element) return false;
      if (c.visible && !isVisible(element)) return false;
      if (c.filled && !isFilled(element)) return false;
      if (c.minLength !== undefined && !hasMinLength(element, c.minLength)) return false;
      const text = textOf(element);
      if (c.text !== undefined && !text.includes(c.text)) return false;
      if (c.textMatch !== undefined) {
        try {
          if (!new RegExp(c.textMatch).test(text)) return false;
        } catch {
          return false;
        }
      }
      return true;
    }
  }
}
