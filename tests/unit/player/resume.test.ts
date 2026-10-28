import { describe, expect, it } from 'vitest';
import { reachesUrl, suggestResume } from '../../../src/core/player/resume';
import type { Step } from '../../../src/schema/rule';

const base = { timeoutMs: 1000, retries: 0, optional: false };
const css = (value: string) => ({ strategies: [{ kind: 'css' as const, value }] });
const click = (id: string): Step => ({ ...base, id, type: 'click', target: css(`#${id}`) });
const open = (id: string, url: string): Step => ({ ...base, id, type: 'open', url, newTab: false });
const nav = (
  id: string,
  urlPattern?: string,
  until: 'navigation' | 'newTab' = 'navigation',
): Step => ({ ...base, id, type: 'waitFor', until, ...(urlPattern ? { urlPattern } : {}) }) as Step;
const switchTab = (id: string, urlPattern: string): Step => ({
  ...base,
  id,
  type: 'switchTab',
  urlPattern,
});

const O = 'https://example.com';

describe('suggestResume', () => {
  const steps: Step[] = [
    click('a'), // 0
    click('missing'), // 1 失败
    click('next'), // 2
    nav('w2', `${O}/step2.html*`), // 3
    click('done'), // 4
    nav('w3', `${O}/step3.html*`), // 5
    click('final'), // 6
  ];

  it('失败后没有导航：建议失败的那一步', () => {
    expect(suggestResume(steps, 1, `${O}/step2.html`, false)).toBe(1);
  });

  it('导航到后续页：建议到达该页之后的第一步', () => {
    expect(suggestResume(steps, 1, `${O}/step2.html?x=1`, true)).toBe(4);
  });

  it('多段跳转：取最后一段匹配的', () => {
    expect(suggestResume(steps, 1, `${O}/step3.html`, true)).toBe(6);
  });

  it('只看失败步骤及其后面的步骤', () => {
    expect(suggestResume(steps, 4, `${O}/step2.html`, true)).toBe(4);
  });

  it('导航了但都不匹配：建议失败的那一步', () => {
    expect(suggestResume(steps, 1, `${O}/other.html`, true)).toBe(1);
    expect(suggestResume(steps, 1, '', true)).toBe(1);
  });

  it('到达页面的步骤是最后一步：越界时建议 steps.length', () => {
    const s = [click('x'), nav('w', `${O}/end.html`)];
    expect(suggestResume(s, 0, `${O}/end.html`, true)).toBe(2);
  });

  it('失败的那一步本身就是到达该页的步骤：建议下一步', () => {
    const s = [open('o', `${O}/a`), click('y')];
    expect(suggestResume(s, 0, `${O}/a`, true)).toBe(1);
  });

  it('open 用 origin + path 作前缀比较，忽略查询串', () => {
    const s = [click('x'), open('o', `${O}/list?page=1`), click('y')];
    expect(suggestResume(s, 0, `${O}/list?page=9`, true)).toBe(2);
    expect(suggestResume(s, 0, `${O}/list/detail`, true)).toBe(2);
    expect(suggestResume(s, 0, 'https://example.org/list', true)).toBe(0);
  });

  it('含占位符的 open 跳过', () => {
    const s = [click('x'), open('o', `${O}/{{var.path}}`), click('y')];
    expect(suggestResume(s, 0, `${O}/`, true)).toBe(0);
  });

  it('newTab 与 switchTab 的 urlPattern 也算', () => {
    const s = [
      click('x'),
      nav('n', `${O}/pay*`, 'newTab'),
      switchTab('t', `${O}/cart*`),
      click('y'),
    ];
    expect(suggestResume(s, 0, `${O}/pay/1`, true)).toBe(2);
    expect(suggestResume(s, 0, `${O}/cart`, true)).toBe(3);
  });
});

describe('reachesUrl', () => {
  it('没有 urlPattern 的 waitFor 与其他类型不算', () => {
    expect(reachesUrl(nav('w'), `${O}/`)).toBe(false);
    expect(reachesUrl({ ...base, id: 'd', type: 'waitFor', until: 'delay', delayMs: 1 }, O)).toBe(
      false,
    );
    expect(reachesUrl(click('c'), `${O}/`)).toBe(false);
  });

  it('无法解析的 open 网址不算', () => {
    expect(reachesUrl(open('o', 'not a url'), `${O}/`)).toBe(false);
  });
});
