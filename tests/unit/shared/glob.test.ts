import { describe, expect, it } from 'vitest';
import {
  globToRegExp,
  hostAllowed,
  hostnameOf,
  isMatchAll,
  matchesAnyGlob,
  matchesGlob,
  originPatternOf,
} from '../../../src/shared/glob';

describe('matchesGlob', () => {
  it('* 匹配任意字符，包括斜杠', () => {
    expect(matchesGlob('https://example.com/*', 'https://example.com/a/b?c=1')).toBe(true);
  });

  it('? 匹配单个字符', () => {
    expect(matchesGlob('https://example.com/a?', 'https://example.com/ab')).toBe(true);
    expect(matchesGlob('https://example.com/a?', 'https://example.com/abc')).toBe(false);
  });

  it('整串匹配，前后多余字符不命中', () => {
    expect(matchesGlob('https://example.com/', 'https://example.com/x')).toBe(false);
    expect(matchesGlob('example.com/*', 'https://example.com/x')).toBe(false);
  });

  it('正则元字符按字面匹配', () => {
    expect(matchesGlob('https://example.com/a.b', 'https://example.com/aXb')).toBe(false);
    expect(matchesGlob('https://example.com/a+b(1)', 'https://example.com/a+b(1)')).toBe(true);
  });

  it('子域通配符', () => {
    expect(matchesGlob('https://*.example.com/*', 'https://www.example.com/x')).toBe(true);
    expect(matchesGlob('https://*.example.com/*', 'https://example.com/x')).toBe(false);
  });

  it('globToRegExp 返回带锚点的正则', () => {
    expect(globToRegExp('a*').source).toBe('^a.*$');
  });

  it('matchesAnyGlob 任一命中即可，空列表不命中', () => {
    expect(matchesAnyGlob(['https://a.com/*', 'https://b.com/*'], 'https://b.com/x')).toBe(true);
    expect(matchesAnyGlob([], 'https://b.com/x')).toBe(false);
  });
});

describe('isMatchAll', () => {
  it.each(['<all_urls>', '*', '*://*/*', 'https://*/*', 'http://*/*', 'http*://*/*', 'https://*'])(
    '%s 视为匹配全部',
    (g) => {
      expect(isMatchAll(g)).toBe(true);
    },
  );

  it.each([
    'https://*.example.com/*',
    'https://example.com/*',
    '*://example.com/*',
    'https://*example.com/*',
  ])('%s 不是匹配全部', (g) => {
    expect(isMatchAll(g)).toBe(false);
  });
});

describe('originPatternOf', () => {
  it('提取 scheme 与主机', () => {
    expect(originPatternOf('https://example.com/a/*')).toBe('https://example.com/*');
    expect(originPatternOf('*://example.com/*')).toBe('*://example.com/*');
  });

  it('保留 *. 子域通配', () => {
    expect(originPatternOf('https://*.example.com/x')).toBe('https://*.example.com/*');
  });

  it('去掉端口', () => {
    expect(originPatternOf('http://localhost:3000/*')).toBe('http://localhost/*');
  });

  it('主机中间或末尾含通配符时无法申请权限', () => {
    expect(originPatternOf('https://www.*.com/*')).toBeNull();
    expect(originPatternOf('https://example*/*')).toBeNull();
  });

  it('非 http(s)/* 开头返回 null', () => {
    expect(originPatternOf('ftp://example.com/*')).toBeNull();
    expect(originPatternOf('example.com/*')).toBeNull();
  });
});

describe('hostnameOf', () => {
  it('取主机名，非法 URL 返回空串', () => {
    expect(hostnameOf('https://a.example.com:8080/x')).toBe('a.example.com');
    expect(hostnameOf('not a url')).toBe('');
  });
});

describe('hostAllowed', () => {
  it('精确域名匹配', () => {
    expect(hostAllowed('example.com', ['example.com'])).toBe(true);
    expect(hostAllowed('www.example.com', ['example.com'])).toBe(false);
  });

  it('*.example.com 匹配子域与根域', () => {
    expect(hostAllowed('a.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('a.b.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(true);
  });

  it('*.example.com 不匹配 evilexample.com 与 example.com.evil.com', () => {
    expect(hostAllowed('evilexample.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('example.com.evil.com', ['*.example.com'])).toBe(false);
  });

  it('空列表一律拒绝', () => {
    expect(hostAllowed('example.com', [])).toBe(false);
  });
});
