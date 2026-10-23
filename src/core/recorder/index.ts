import type { RecordedAction } from '../../shared/content-api';
import { generateLocator, isSensitive } from '../selector';

/** content 侧录制：捕获阶段监听用户操作，交给 emit 上报给后台聚合 */

const TEXT_LIKE =
  /^(text|search|email|tel|url|number|password|date|time|datetime-local|month|week)?$/;

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXT_LIKE.test(el.type);
}

function fieldName(el: Element): string {
  const raw =
    el.getAttribute('name') ||
    el.id ||
    el.getAttribute('aria-label') ||
    el.getAttribute('type') ||
    'field';
  return raw.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
}

export function createRecorder(emit: (action: RecordedAction) => void) {
  const lastValue = new WeakMap<Element, string>();
  let attached = false;

  const recordFill = (el: HTMLInputElement | HTMLTextAreaElement) => {
    if (lastValue.get(el) === el.value) return;
    lastValue.set(el, el.value);
    emit({
      kind: 'fill',
      locator: generateLocator(el),
      value: el.value,
      sensitive: isSensitive(el),
      fieldName: fieldName(el),
    });
  };

  const onClick = (ev: MouseEvent) => {
    if (!ev.isTrusted || !(ev.target instanceof Element)) return;
    const target =
      ev.target.closest(
        'a, button, [role="button"], [role="tab"], [role="menuitem"], summary, label, input, select',
      ) ?? ev.target;
    // 输入框、下拉框、勾选框由 change 记录；点击仅用于聚焦
    if (isTextField(target) || target instanceof HTMLSelectElement) return;
    if (
      target instanceof HTMLInputElement &&
      (target.type === 'checkbox' || target.type === 'radio')
    )
      return;
    emit({ kind: 'click', locator: generateLocator(target) });
  };

  const onChange = (ev: Event) => {
    const el = ev.target;
    if (!(el instanceof Element) || !ev.isTrusted) return;
    if (isTextField(el)) recordFill(el);
    else if (el instanceof HTMLSelectElement) {
      emit({ kind: 'select', locator: generateLocator(el), value: el.value });
    } else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      emit({ kind: 'check', locator: generateLocator(el), checked: el.checked });
    }
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (!ev.isTrusted || !(ev.target instanceof Element)) return;
    if (ev.key !== 'Enter' && ev.key !== 'Escape') return;
    const el = ev.target;
    if (ev.key === 'Enter' && el instanceof HTMLTextAreaElement) return;
    if (isTextField(el)) recordFill(el);
    emit({ kind: 'press', locator: generateLocator(el), key: ev.key });
  };

  return {
    start() {
      if (attached) return;
      attached = true;
      document.addEventListener('click', onClick, true);
      document.addEventListener('change', onChange, true);
      document.addEventListener('keydown', onKeyDown, true);
    },
    stop() {
      if (!attached) return;
      attached = false;
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('keydown', onKeyDown, true);
    },
  };
}
