import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFakeBrowser } from '../../helpers/fake-browser';
import { makeRule, rawRule } from '../../helpers/rule-fixtures';

vi.mock('wxt/browser', async () => (await import('../../helpers/fake-browser')).browserModule);

const rules = await import('../../../src/core/rules');
const { applyDownlink, fingerprint } = rules;

const uid = 'u1';
const env = { v: 1 as const, id: 'm' };
const snapshot = (seq: number, list: Record<string, unknown>[]) =>
  ({ ...env, kind: 'snapshot', seq, rules: list }) as const;
const upsert = (seq: number, rule: Record<string, unknown>) =>
  ({ ...env, kind: 'ruleUpsert', seq, rule }) as const;
const remove = (seq: number, ruleId: string) =>
  ({ ...env, kind: 'ruleRemove', seq, ruleId }) as const;

beforeEach(() => {
  resetFakeBrowser();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('applyDownlink 增量应用', () => {
  it('按序号依次应用 upsert 并推进 lastSeq', async () => {
    await applyDownlink(uid, snapshot(0, []));
    expect(await applyDownlink(uid, upsert(1, rawRule({ id: 'a' })))).toEqual({
      type: 'applied',
      removedRuleIds: [],
    });
    expect(await rules.lastSeq(uid)).toBe(1);
    expect((await rules.listRules(uid)).map((r) => r.id)).toEqual(['a']);
  });

  it('序号不大于本地序号视为重复且不改动数据', async () => {
    await applyDownlink(uid, snapshot(3, [rawRule({ id: 'a' })]));
    expect(await applyDownlink(uid, upsert(3, rawRule({ id: 'b' })))).toEqual({
      type: 'duplicate',
    });
    expect(await applyDownlink(uid, upsert(2, rawRule({ id: 'b' })))).toEqual({
      type: 'duplicate',
    });
    expect((await rules.listRules(uid)).map((r) => r.id)).toEqual(['a']);
  });

  it('序号出现缺口返回 gap，且不应用该消息', async () => {
    await applyDownlink(uid, snapshot(1, []));
    expect(await applyDownlink(uid, upsert(3, rawRule({ id: 'a' })))).toEqual({ type: 'gap' });
    expect(await rules.listRules(uid)).toEqual([]);
    expect(await rules.lastSeq(uid)).toBe(1);
  });

  it('没有任何缓存时 seq=1 可直接应用，seq=2 视为缺口', async () => {
    expect(await applyDownlink(uid, upsert(2, rawRule()))).toEqual({ type: 'gap' });
    expect((await applyDownlink(uid, upsert(1, rawRule()))).type).toBe('applied');
  });

  it('版本只增不减：旧版本与同版本的 upsert 被忽略', async () => {
    await applyDownlink(uid, snapshot(0, []));
    await applyDownlink(uid, upsert(1, rawRule({ version: 5, name: 'v5' })));
    await applyDownlink(uid, upsert(2, rawRule({ version: 4, name: 'v4' })));
    await applyDownlink(uid, upsert(3, rawRule({ version: 5, name: 'v5b' })));
    expect((await rules.getRule(uid, 'r1'))?.name).toBe('v5');
    expect(await rules.lastSeq(uid)).toBe(3);
  });

  it('更高版本覆盖旧版本', async () => {
    await applyDownlink(uid, snapshot(0, []));
    await applyDownlink(uid, upsert(1, rawRule({ version: 1, name: 'old' })));
    await applyDownlink(uid, upsert(2, rawRule({ version: 2, name: 'new' })));
    expect((await rules.getRule(uid, 'r1'))?.name).toBe('new');
  });

  it('坏规则被丢弃但序号照常推进', async () => {
    await applyDownlink(uid, snapshot(0, []));
    const res = await applyDownlink(uid, upsert(1, { id: 'bad' }));
    expect(res.type).toBe('applied');
    expect(await rules.listRules(uid)).toEqual([]);
    expect(await rules.lastSeq(uid)).toBe(1);
  });

  it('ruleRemove 删除规则并返回被移除的 id', async () => {
    await applyDownlink(uid, snapshot(1, [rawRule({ id: 'a' })]));
    expect(await applyDownlink(uid, remove(2, 'a'))).toEqual({
      type: 'applied',
      removedRuleIds: ['a'],
    });
    expect(await rules.getRule(uid, 'a')).toBeUndefined();
  });

  it('移除不存在的规则返回空 removedRuleIds', async () => {
    await applyDownlink(uid, snapshot(1, []));
    expect(await applyDownlink(uid, remove(2, 'nope'))).toEqual({
      type: 'applied',
      removedRuleIds: [],
    });
  });
});

describe('applyDownlink snapshot', () => {
  it('全量替换并返回被移除的规则 id', async () => {
    await applyDownlink(uid, snapshot(1, [rawRule({ id: 'a' }), rawRule({ id: 'b' })]));
    const res = await applyDownlink(uid, snapshot(5, [rawRule({ id: 'b' }), rawRule({ id: 'c' })]));
    expect(res).toEqual({ type: 'applied', removedRuleIds: ['a'] });
    expect((await rules.listRules(uid)).map((r) => r.id).sort()).toEqual(['b', 'c']);
    expect(await rules.lastSeq(uid)).toBe(5);
  });

  it('snapshot 里的坏规则被丢弃，好规则保留', async () => {
    await applyDownlink(
      uid,
      snapshot(1, [rawRule({ id: 'ok' }), rawRule({ id: 'bad', match: { urls: ['<all_urls>'] } })]),
    );
    expect((await rules.listRules(uid)).map((r) => r.id)).toEqual(['ok']);
  });

  it('snapshot 不受序号比较约束（即使序号更小也替换）', async () => {
    await applyDownlink(uid, snapshot(10, [rawRule({ id: 'a' })]));
    await applyDownlink(uid, snapshot(2, [rawRule({ id: 'z' })]));
    expect(await rules.lastSeq(uid)).toBe(2);
    expect((await rules.listRules(uid)).map((r) => r.id)).toEqual(['z']);
  });

  it('不同用户的缓存互相隔离', async () => {
    await applyDownlink('u1', snapshot(1, [rawRule({ id: 'a' })]));
    expect(await rules.listRules('u2')).toEqual([]);
    expect(await rules.lastSeq('u2')).toBe(0);
  });

  it('clearUser 清空该用户缓存', async () => {
    await applyDownlink(uid, snapshot(4, [rawRule()]));
    await rules.clearUser(uid);
    expect(await rules.listRules(uid)).toEqual([]);
    expect(await rules.lastSeq(uid)).toBe(0);
  });
});

describe('matchRules', () => {
  const a = makeRule({
    id: 'a',
    match: { urls: ['https://example.com/*'], exclude: ['*/admin*'] },
  });
  const b = makeRule({ id: 'b', enabled: false });

  it('命中 urls、未命中 exclude 且已启用的规则', () => {
    expect(rules.matchRules([a, b], 'https://example.com/x').map((r) => r.id)).toEqual(['a']);
  });

  it('命中 exclude 的页面不匹配', () => {
    expect(rules.matchRules([a], 'https://example.com/admin/users')).toEqual([]);
  });

  it('其他站点不匹配', () => {
    expect(rules.matchRules([a], 'https://other.com/x')).toEqual([]);
  });
});

describe('fingerprint 与确认流程', () => {
  it('对匹配范围、requires、inputMode 变化敏感', () => {
    const base = makeRule({ requires: { profile: ['a'], secret: ['s'] } });
    const f = fingerprint(base);
    expect(
      fingerprint(
        makeRule({
          requires: { profile: ['a'], secret: ['s'] },
          match: { urls: ['https://example.com/*', 'https://b.com/*'] },
        }),
      ),
    ).not.toBe(f);
    expect(
      fingerprint(
        makeRule({
          requires: { profile: ['a'], secret: ['s'] },
          match: { urls: ['https://example.com/*'], exclude: ['*/x'] },
        }),
      ),
    ).not.toBe(f);
    expect(fingerprint(makeRule({ requires: { profile: ['a', 'b'], secret: ['s'] } }))).not.toBe(f);
    expect(fingerprint(makeRule({ requires: { profile: ['a'], secret: [] } }))).not.toBe(f);
    expect(
      fingerprint(
        makeRule({ requires: { profile: ['a'], secret: ['s'] }, inputMode: 'synthetic' }),
      ),
    ).not.toBe(f);
  });

  it('对 name、version、steps 变化不敏感', () => {
    const f = fingerprint(makeRule());
    expect(fingerprint(makeRule({ name: '别的名字', version: 9 }))).toBe(f);
    expect(
      fingerprint(
        makeRule({
          steps: [{ id: 'z', type: 'open', url: 'https://example.com/other' }],
        }),
      ),
    ).toBe(f);
  });

  it('对数组顺序不敏感', () => {
    const x = makeRule({ match: { urls: ['https://a.com/*', 'https://b.com/*'] } });
    const y = makeRule({ match: { urls: ['https://b.com/*', 'https://a.com/*'] } });
    expect(fingerprint(x)).toBe(fingerprint(y));
  });

  it('未确认时 isApproved 为 false，确认后为 true', async () => {
    const r = makeRule();
    expect(await rules.isApproved(uid, r)).toBe(false);
    await rules.approveRule(uid, r);
    expect(await rules.isApproved(uid, r)).toBe(true);
  });

  it('规则的匹配范围变化后需要重新确认', async () => {
    const r = makeRule();
    await rules.approveRule(uid, r);
    const widened = makeRule({ match: { urls: ['https://example.com/*', 'https://b.com/*'] } });
    expect(await rules.isApproved(uid, widened)).toBe(false);
  });

  it('仅改名称或步骤不会让确认失效', async () => {
    await rules.approveRule(uid, makeRule());
    expect(await rules.isApproved(uid, makeRule({ name: 'x', version: 2 }))).toBe(true);
  });

  it('确认状态按用户隔离', async () => {
    const r = makeRule();
    await rules.approveRule('u1', r);
    expect(await rules.isApproved('u2', r)).toBe(false);
  });

  it('自动运行开关可开可关且不重复', async () => {
    await rules.setAutoEnabled(uid, 'a', true);
    await rules.setAutoEnabled(uid, 'a', true);
    await rules.setAutoEnabled(uid, 'b', true);
    expect(await rules.autoEnabledIds(uid)).toEqual(['a', 'b']);
    await rules.setAutoEnabled(uid, 'a', false);
    expect(await rules.autoEnabledIds(uid)).toEqual(['b']);
  });
});

describe('parseRule', () => {
  it('合法规则返回 ok，非法规则带出首个错误信息', () => {
    expect(rules.parseRule(rawRule()).ok).toBe(true);
    const bad = rules.parseRule(rawRule({ match: { urls: ['<all_urls>'] } }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain('匹配全部网站');
  });
});
