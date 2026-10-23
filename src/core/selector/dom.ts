/**
 * 跨 frame 安全的元素类型判断。
 * 同源 iframe 里的元素属于子 frame 自己的 JS 环境，对顶层的构造函数做 instanceof 会得到 false，
 * 所以这里按 nodeType 与标签名判断。
 */

export function isElement(n: unknown): n is Element {
  return typeof n === 'object' && n !== null && (n as Node).nodeType === 1;
}

const tagIs = (el: unknown, tag: string): boolean =>
  isElement(el) && el.tagName.toUpperCase() === tag;

export const isInput = (el: unknown): el is HTMLInputElement => tagIs(el, 'INPUT');
export const isTextarea = (el: unknown): el is HTMLTextAreaElement => tagIs(el, 'TEXTAREA');
export const isSelect = (el: unknown): el is HTMLSelectElement => tagIs(el, 'SELECT');
export const isIframe = (el: unknown): el is HTMLIFrameElement => tagIs(el, 'IFRAME');
export const isImage = (el: unknown): el is HTMLImageElement => tagIs(el, 'IMG');
export const isHtmlElement = (el: unknown): el is HTMLElement => isElement(el) && 'style' in el;
