/** URL glob：`*` 匹配任意字符，`?` 匹配单个字符 */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('')
    .map((c) => {
      if (c === '*') return '.*';
      if (c === '?') return '.';
      return c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${body}$`);
}

export function matchesGlob(glob: string, url: string): boolean {
  return globToRegExp(glob).test(url);
}

export function matchesAnyGlob(globs: string[], url: string): boolean {
  return globs.some((g) => matchesGlob(g, url));
}

/** 过宽的匹配：覆盖全部网站（或主机部分为单独的 `*`） */
export function isMatchAll(glob: string): boolean {
  if (glob === '<all_urls>' || glob === '*') return true;
  return /^(?:\*|https?|http\*):\/\/\*(?:\/.*)?$/.test(glob);
}

/** 由 URL glob 得到可申请的主机权限（match pattern） */
export function originPatternOf(glob: string): string | null {
  const m = /^(\*|https?):\/\/([^/]+)/.exec(glob);
  if (!m?.[1] || !m[2]) return null;
  const host = m[2].replace(/:\d+$/, '');
  if (host.includes('*') && !host.startsWith('*.')) return null;
  return `${m[1]}://${host}/*`;
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 域名是否命中允许列表：支持精确域名与 `*.example.com` */
export function hostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((a) => {
    if (a.startsWith('*.')) {
      const base = a.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return host === a;
  });
}
