import { useMemo } from 'react';
import { ErrorText } from '../../shared/ui/components';
import { useBgState } from '../../shared/ui/useBgState';
import { Recording } from './Recording';
import { RunItem } from './RunItem';

export function App() {
  const { state, error } = useBgState();

  const runs = useMemo(() => {
    if (!state) return [];
    const isActive = (s: string) => s === 'running' || s === 'handoff';
    return [...state.runs].sort((a, b) => {
      const d = Number(isActive(b.status)) - Number(isActive(a.status));
      return d !== 0 ? d : b.startedAt - a.startedAt;
    });
  }, [state]);

  return (
    <main className="min-h-screen space-y-4 bg-slate-50 p-3 text-slate-900">
      <h1 className="text-base font-bold">PagePilot</h1>
      {!state ? (
        error ? (
          <ErrorText>{error}</ErrorText>
        ) : (
          <p role="status" className="text-sm text-slate-500">
            加载中…
          </p>
        )
      ) : (
        <>
          <section aria-labelledby="runs-title" className="space-y-2">
            <h2 id="runs-title" className="text-sm font-semibold text-slate-700">
              运行
            </h2>
            {runs.length === 0 ? (
              <p className="text-sm text-slate-500">暂无运行记录。</p>
            ) : (
              runs.map((r) => <RunItem key={r.runId} run={r} />)
            )}
          </section>
          <Recording recording={state.recording} />
        </>
      )}
    </main>
  );
}
