export type PlaceholderScope = 'profile' | 'secret' | 'var';

export interface Placeholder {
  scope: PlaceholderScope;
  key: string;
}

const source = String.raw`\\\{\{|\{\{\s*(profile|secret|var)\.([A-Za-z0-9_.-]+)\s*\}\}`;

/** 提取文本中的占位符，`\{{` 转义的不算 */
export function extractPlaceholders(text: string): Placeholder[] {
  const found: Placeholder[] = [];
  for (const m of text.matchAll(new RegExp(source, 'g'))) {
    if (m[1] && m[2]) found.push({ scope: m[1] as PlaceholderScope, key: m[2] });
  }
  return found;
}

/** 渲染模板；解析器抛错时整体失败，不会把占位符原文留在结果里 */
export function renderTemplate(
  text: string,
  resolve: (scope: PlaceholderScope, key: string) => string,
): string {
  return text.replace(new RegExp(source, 'g'), (_whole, scope?: string, key?: string) => {
    if (!scope || !key) return '{{';
    return resolve(scope as PlaceholderScope, key);
  });
}
