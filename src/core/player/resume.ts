import type { Step } from '../../schema/rule';
import { matchesGlob } from '../../shared/glob';

/**
 * 步骤失败暂停后，判断用户手动处理到了哪一步。
 *
 * - 失败后标签页没有导航过：用户多半是在当前页修好了问题，建议重试失败的那一步。
 * - 导航过：在失败步骤及其后面的同级步骤里从后往前找“到达某页”的步骤
 *   （open / 带 urlPattern 的 waitFor(navigation|newTab) / switchTab），
 *   它的网址规则与当前网址匹配时，建议从它的下一步继续（越界时为 steps.length，表示这一层已完成）。
 * - 都不匹配：建议失败的那一步。
 */
export function suggestResume(
  steps: readonly Step[],
  failedIndex: number,
  currentUrl: string,
  navigatedSinceFailure: boolean,
): number {
  if (!navigatedSinceFailure || !currentUrl) return failedIndex;
  for (let j = steps.length - 1; j >= failedIndex; j--) {
    const step = steps[j];
    if (step && reachesUrl(step, currentUrl)) return Math.min(j + 1, steps.length);
  }
  return failedIndex;
}

/** 步骤是否表示“到达了 url 所在的页面” */
export function reachesUrl(step: Step, url: string): boolean {
  switch (step.type) {
    case 'open': {
      const prefix = urlPrefix(step.url);
      return prefix !== null && url.startsWith(prefix);
    }
    case 'waitFor':
      return (
        (step.until === 'navigation' || step.until === 'newTab') &&
        !!step.urlPattern &&
        matchesGlob(step.urlPattern, url)
      );
    case 'switchTab':
      return matchesGlob(step.urlPattern, url);
    default:
      return false;
  }
}

/** open 步骤网址的 origin + path；含占位符或无法解析时返回 null */
function urlPrefix(raw: string): string | null {
  if (raw.includes('{{')) return null;
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}
