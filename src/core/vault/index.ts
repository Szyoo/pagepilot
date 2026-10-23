import { type LocalData, localDataSchema } from '../../schema/profile';
import { hostAllowed } from '../../shared/glob';
import { getItem, setItem } from '../../shared/storage';
import type { PlaceholderScope } from '../../shared/template';

/**
 * 本地数据保险库：个人信息与凭据只存在本机浏览器里，不会上报。
 * 身份已由门户登录确认，所以不再设主密码；数据按门户用户隔离。
 */

const key = (userId: string) => `vault:${userId}`;

export class VaultError extends Error {
  constructor(
    readonly code: 'DATA_MISSING' | 'SECRET_ORIGIN_DENIED',
    message: string,
  ) {
    super(message);
  }
}

export async function loadVault(userId: string): Promise<LocalData> {
  const stored = await getItem<unknown>('local', key(userId), {});
  const parsed = localDataSchema.safeParse(stored);
  return parsed.success ? parsed.data : localDataSchema.parse({});
}

export async function saveVault(userId: string, data: LocalData): Promise<void> {
  await setItem('local', key(userId), localDataSchema.parse(data));
}

/** 导出为 JSON 文本（明文，请自行妥善保管） */
export async function exportVault(userId: string): Promise<string> {
  return JSON.stringify(await loadVault(userId), null, 2);
}

export async function importVault(userId: string, backup: string): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(backup);
  } catch {
    throw new Error('备份格式不正确');
  }
  const parsed = localDataSchema.safeParse(raw);
  if (!parsed.success) throw new Error('备份格式不正确');
  await saveVault(userId, parsed.data);
}

/** 解析一个占位符；secret 还要校验目标页面域名 */
export function resolvePlaceholder(
  data: LocalData,
  scope: Exclude<PlaceholderScope, 'var'>,
  name: string,
  pageHost: string,
): string {
  const value = data[scope][name];
  if (value === undefined) throw new VaultError('DATA_MISSING', `缺少本地数据：${scope}.${name}`);
  if (scope === 'secret' && !hostAllowed(pageHost, data.secretOrigins[name] ?? [])) {
    throw new VaultError('SECRET_ORIGIN_DENIED', `凭据 ${name} 不允许在 ${pageHost} 使用`);
  }
  return value;
}

/** 规则所需的本地数据里缺失的键 */
export function missingData(
  data: LocalData,
  requires: { profile: string[]; secret: string[] },
): string[] {
  return [
    ...requires.profile.filter((k) => data.profile[k] === undefined).map((k) => `profile.${k}`),
    ...requires.secret.filter((k) => data.secret[k] === undefined).map((k) => `secret.${k}`),
  ];
}

/** 本地个人信息值 -> 键名，供录制脱敏使用 */
export function profileValueIndex(data: LocalData): Map<string, string> {
  return new Map(Object.entries(data.profile).map(([k, v]) => [v, k]));
}
