// claude-bridge 地址的发现：设置页手动填写（覆盖） > 后台 /api/ai/status 返回 > 构建期默认值。
// 纯逻辑与带缓存的后台查询放在这里，background 注入 fetchWithSession 使用。

import { normalizeBridgeUrl } from './bridge';

export const DEFAULT_ASSIST_SCOPE = 'pagepilot';
export const BACKEND_AI_TTL_MS = 5 * 60 * 1000;

export type BridgeSource = 'settings' | 'backend' | 'build';

export interface BridgeInfo {
  bridgeUrl: string | null;
  scope: string;
  /** 后台报告 AI 可用（后台未登录或不可达时为 false） */
  available: boolean;
  source: BridgeSource | null;
}

/** 后台 /api/ai/status 的有效内容 */
export interface BackendAi {
  available: boolean;
  bridgeUrl: string | null;
  scope: string | null;
}

export function parseBackendAi(body: unknown): BackendAi | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const scope = typeof b.scope === 'string' && b.scope.trim() ? b.scope.trim() : null;
  return {
    available: b.available === true,
    bridgeUrl: typeof b.bridgeUrl === 'string' ? normalizeBridgeUrl(b.bridgeUrl) : null,
    scope,
  };
}

export function pickBridge(input: {
  settingsUrl?: string;
  buildUrl?: string;
  backend: BackendAi | null;
}): BridgeInfo {
  const fromSettings = normalizeBridgeUrl(input.settingsUrl);
  const fromBackend = input.backend?.available ? input.backend.bridgeUrl : null;
  const fromBuild = normalizeBridgeUrl(input.buildUrl);
  const [bridgeUrl, source]: [string | null, BridgeSource | null] = fromSettings
    ? [fromSettings, 'settings']
    : fromBackend
      ? [fromBackend, 'backend']
      : fromBuild
        ? [fromBuild, 'build']
        : [null, null];
  return {
    bridgeUrl,
    scope: input.backend?.scope ?? DEFAULT_ASSIST_SCOPE,
    available: input.backend?.available === true,
    source,
  };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** 后台 AI 状态的内存缓存（按 用户 + 后台地址 分键，失败不缓存） */
export function createBackendAiCache({
  fetchImpl,
  ttlMs = BACKEND_AI_TTL_MS,
  now = Date.now,
}: {
  fetchImpl: FetchLike;
  ttlMs?: number;
  now?: () => number;
}) {
  let entry: { key: string; at: number; value: BackendAi } | null = null;

  return {
    clear() {
      entry = null;
    },
    /** 未登录或没有后台地址时不发请求，返回 null；请求失败也返回 null */
    async get(backendUrl: string | undefined, uid: string | undefined): Promise<BackendAi | null> {
      if (!backendUrl || !uid) return null;
      const base = backendUrl.replace(/\/+$/, '');
      const key = `${uid}|${base}`;
      if (entry && entry.key === key && now() - entry.at < ttlMs) return entry.value;
      try {
        const res = await fetchImpl(`${base}/api/ai/status`);
        if (!res.ok) return null;
        const value = parseBackendAi(await res.json());
        if (!value) return null;
        entry = { key, at: now(), value };
        return value;
      } catch {
        return null;
      }
    },
  };
}
