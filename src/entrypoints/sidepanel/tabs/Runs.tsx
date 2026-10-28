import { useMemo } from 'react';
import { type BgState, type RunView, rpc } from '../../../shared/rpc';
import { useAction } from '../../../shared/ui/useAction';
import { useNow } from '../hooks';
import { isActiveRun, sortRuns } from '../lib';
import { Btn, Empty, ErrorLine } from '../parts';
import { RunCard } from '../RunCard';

export function Runs({ state, onAssist }: { state: BgState; onAssist?: (run: RunView) => void }) {
  const clearAll = useAction();
  const runs = useMemo(() => sortRuns(state.runs), [state.runs]);
  const hasActive = runs.some(isActiveRun);
  const now = useNow(hasActive);
  const ended = runs.filter((r) => !isActiveRun(r));

  if (runs.length === 0)
    return <Empty title="还没有运行记录" sub="在「当前页」运行规则后会显示在这里" />;

  return (
    <>
      <ul style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {runs.map((r) => (
          <li key={r.runId}>
            <RunCard
              run={r}
              rule={state.rules.find((x) => x.id === r.ruleId)}
              now={now}
              onAssist={onAssist}
            />
          </li>
        ))}
      </ul>
      {ended.length > 0 ? (
        <>
          <Btn
            size="sm"
            disabled={clearAll.busy}
            onClick={() =>
              void clearAll.run(async () => {
                for (const r of ended) await rpc('run.dismiss', { runId: r.runId });
              })
            }
          >
            清除全部已结束
          </Btn>
          <ErrorLine>{clearAll.error}</ErrorLine>
        </>
      ) : null}
    </>
  );
}
