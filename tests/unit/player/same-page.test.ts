import { describe, expect, it, vi } from 'vitest';

vi.mock('wxt/browser', async () => (await import('../../helpers/fake-browser')).browserModule);

const { samePage } = await import('../../../src/core/player/runner');

describe('samePage：open 步骤判断是否已在目标页面', () => {
  it('网站与路径相同即视为同一页面，忽略查询参数、锚点与末尾斜杠', () => {
    expect(
      samePage('https://example.com/en/main.do?lang=en#top', 'https://example.com/en/main.do'),
    ).toBe(true);
    expect(samePage('https://example.com/en/', 'https://example.com/en')).toBe(true);
    expect(samePage('https://example.com/', 'https://example.com')).toBe(true);
  });

  it('路径、主机、协议或端口不同都不是同一页面', () => {
    expect(samePage('https://example.com/en/main.do', 'https://example.com/en/login.do')).toBe(
      false,
    );
    expect(samePage('https://a.example.com/x', 'https://b.example.com/x')).toBe(false);
    expect(samePage('http://example.com/x', 'https://example.com/x')).toBe(false);
    expect(samePage('https://example.com:8443/x', 'https://example.com/x')).toBe(false);
  });

  it('无法解析的地址视为不同', () => {
    expect(samePage('about:blank', 'https://example.com/')).toBe(false);
    expect(samePage('not a url', 'https://example.com/')).toBe(false);
  });
});
