import { useMemo, useState } from 'react';
import type { BgState } from '../../../shared/rpc';
import { filterRules } from '../lib';
import { Btn, Empty } from '../parts';
import { RuleCard } from '../RuleCard';

export function Rules({
  state,
  adminHref,
  onOpenAdmin,
}: {
  state: BgState;
  adminHref: string | null;
  onOpenAdmin: () => void;
}) {
  const [query, setQuery] = useState('');
  const rules = useMemo(() => filterRules(state.rules, query), [state.rules, query]);

  if (state.rules.length === 0) {
    return (
      <Empty title="还没有规则" sub="规则由后台下发，先去管理页生成">
        <Btn kind="primary" inline disabled={adminHref === null} onClick={onOpenAdmin}>
          打开管理页
        </Btn>
      </Empty>
    );
  }

  return (
    <>
      <input
        type="search"
        className="input search"
        placeholder="按名称或网址搜索"
        aria-label="搜索规则"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {rules.length === 0 ? (
        <Empty title="没有匹配的规则" sub="换个关键词试试" />
      ) : (
        <ul style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rules.map((r) => (
            <li key={r.id}>
              <RuleCard rule={r} variant="list" />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
