import type { Downlink } from '../../schema/message';
import { type Rule, ruleSchema } from '../../schema/rule';
import { matchesAnyGlob } from '../../shared/glob';
import { getItem, setItem } from '../../shared/storage';

/** 规则缓存、同步序号与用户确认状态，全部按门户用户隔离 */

interface Cache {
  rules: Record<string, Rule>;
  lastSeq: number;
}

const cacheKey = (uid: string) => `rules:${uid}`;
const approvalKey = (uid: string) => `approvals:${uid}`;
const autoKey = (uid: string) => `auto:${uid}`;

const emptyCache = (): Cache => ({ rules: {}, lastSeq: 0 });

export async function loadCache(uid: string): Promise<Cache> {
  return getItem<Cache>('local', cacheKey(uid), emptyCache());
}

export async function listRules(uid: string): Promise<Rule[]> {
  return Object.values((await loadCache(uid)).rules);
}

export async function getRule(uid: string, ruleId: string): Promise<Rule | undefined> {
  return (await loadCache(uid)).rules[ruleId];
}

export async function lastSeq(uid: string): Promise<number> {
  return (await loadCache(uid)).lastSeq;
}

export function parseRule(raw: unknown): { ok: true; rule: Rule } | { ok: false; error: string } {
  const res = ruleSchema.safeParse(raw);
  if (res.success) return { ok: true, rule: res.data };
  const first = res.error.issues[0];
  return { ok: false, error: `${first?.path.join('.') ?? ''} ${first?.message ?? '格式错误'}` };
}

export type ApplyResult =
  | { type: 'applied'; removedRuleIds: string[] }
  | { type: 'duplicate' }
  | { type: 'gap' }
  | { type: 'ignored' };

/**
 * 应用一条带序号的下行消息。
 * seq 不大于本地序号视为重复；出现缺口时返回 gap，由调用方发送 resync。
 */
export async function applyDownlink(
  uid: string,
  msg: Extract<Downlink, { kind: 'snapshot' | 'ruleUpsert' | 'ruleRemove' }>,
): Promise<ApplyResult> {
  const cache = await loadCache(uid);

  if (msg.kind === 'snapshot') {
    const rules: Record<string, Rule> = {};
    for (const raw of msg.rules) {
      const parsed = parseRule(raw);
      if (parsed.ok) rules[parsed.rule.id] = parsed.rule;
      else console.warn('[pagepilot] 丢弃无效规则：', parsed.error);
    }
    const removedRuleIds = Object.keys(cache.rules).filter((id) => !rules[id]);
    await setItem('local', cacheKey(uid), { rules, lastSeq: msg.seq } satisfies Cache);
    return { type: 'applied', removedRuleIds };
  }

  if (msg.seq <= cache.lastSeq) return { type: 'duplicate' };
  if (msg.seq > cache.lastSeq + 1) return { type: 'gap' };

  const removedRuleIds: string[] = [];
  if (msg.kind === 'ruleUpsert') {
    const parsed = parseRule(msg.rule);
    if (!parsed.ok) {
      console.warn('[pagepilot] 丢弃无效规则：', parsed.error);
    } else if (parsed.rule.version > (cache.rules[parsed.rule.id]?.version ?? -1)) {
      cache.rules[parsed.rule.id] = parsed.rule;
    }
  } else if (cache.rules[msg.ruleId]) {
    delete cache.rules[msg.ruleId];
    removedRuleIds.push(msg.ruleId);
  }
  cache.lastSeq = msg.seq;
  await setItem('local', cacheKey(uid), cache);
  return { type: 'applied', removedRuleIds };
}

export async function clearUser(uid: string): Promise<void> {
  await setItem('local', cacheKey(uid), emptyCache());
}

/** 命中页面 URL 的已启用规则 */
export function matchRules(rules: Rule[], url: string): Rule[] {
  return rules.filter(
    (r) => r.enabled && matchesAnyGlob(r.match.urls, url) && !matchesAnyGlob(r.match.exclude, url),
  );
}

/** 确认指纹：匹配范围、所需数据、输入方式任一变化都需要重新确认 */
export function fingerprint(rule: Rule): string {
  return JSON.stringify([
    [...rule.match.urls].sort(),
    [...rule.match.exclude].sort(),
    [...rule.requires.profile].sort(),
    [...rule.requires.secret].sort(),
    rule.inputMode,
  ]);
}

export async function isApproved(uid: string, rule: Rule): Promise<boolean> {
  const map = await getItem<Record<string, string>>('local', approvalKey(uid), {});
  return map[rule.id] === fingerprint(rule);
}

export async function approveRule(uid: string, rule: Rule): Promise<void> {
  const map = await getItem<Record<string, string>>('local', approvalKey(uid), {});
  map[rule.id] = fingerprint(rule);
  await setItem('local', approvalKey(uid), map);
}

export async function autoEnabledIds(uid: string): Promise<string[]> {
  return getItem<string[]>('local', autoKey(uid), []);
}

export async function setAutoEnabled(uid: string, ruleId: string, enabled: boolean): Promise<void> {
  const ids = new Set(await autoEnabledIds(uid));
  if (enabled) ids.add(ruleId);
  else ids.delete(ruleId);
  await setItem('local', autoKey(uid), [...ids]);
}
