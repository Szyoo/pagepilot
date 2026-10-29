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

/** 两个地址是否是同一页面：网站（协议、主机、端口）与路径相同，忽略查询参数、锚点与路径末尾的斜杠 */
export function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL) => u.pathname.replace(/\/+$/, '') || '/';
    return x.origin === y.origin && path(x) === path(y);
  } catch {
    return false;
  }
}

/** 由 URL glob 推出能直接打开的地址：取第一个通配符之前、到最后一个 `/` 为止；协议或主机里有通配符时为 null */
export function openableUrlOf(glob: string): string | null {
  const wild = glob.search(/[*?]/);
  if (wild === -1) return isHttpUrl(glob) ? glob : null;
  const m = /^https?:\/\/[^/*?]+\//.exec(glob);
  if (!m) return null;
  return glob.slice(0, glob.lastIndexOf('/', wild) + 1);
}

/**
 * 规则所属的页面：最外层第一个 `open` 步骤的地址（不含占位符时），
 * 否则由匹配网址推出；都推不出时为 undefined
 */
export function entryUrlOf(rule: {
  steps: readonly { type: string; url?: string }[];
  match: { urls: readonly string[] };
}): string | undefined {
  const open = rule.steps.find((s) => s.type === 'open');
  if (open?.url && !open.url.includes('{{') && isHttpUrl(open.url)) return open.url;
  for (const g of rule.match.urls) {
    const url = openableUrlOf(g);
    if (url) return url;
  }
  return undefined;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
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
