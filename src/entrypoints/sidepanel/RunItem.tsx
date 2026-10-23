import { type RunStatus, type RunView, rpc } from '../../shared/rpc';
import { Badge, Button, Card, ErrorText } from '../../shared/ui/components';
import { useAction } from '../../shared/ui/useAction';

const STATUS: Record<
  RunStatus,
  { label: string; tone: 'gray' | 'green' | 'red' | 'amber' | 'blue' }
> = {
  running: { label: '运行中', tone: 'blue' },
  handoff: { label: '等待你操作', tone: 'amber' },
  succeeded: { label: '已成功', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  aborted: { label: '已中止', tone: 'gray' },
  handedOff: { label: '已交还', tone: 'gray' },
};

export function RunItem({ run }: { run: RunView }) {
  const { busy, error, run: act } = useAction();
  const active = run.status === 'running' || run.status === 'handoff';
  const handoff = run.status === 'handoff';
  const st = STATUS[run.status];

  return (
    <Card
      className={
        handoff ? 'space-y-2 border-amber-400 bg-amber-50 ring-2 ring-amber-300' : 'space-y-2'
      }
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-semibold text-slate-900">{run.ruleName}</p>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      <div className="space-y-0.5 text-xs text-slate-600">
        {run.stepId ? <p>当前步骤：{run.stepId}</p> : null}
        {run.repeat ? (
          <p>
            第 {run.repeat.attempt} / 最多 {run.repeat.max} 轮
          </p>
        ) : null}
        {run.errorCode ? <p className="text-red-700">错误码：{run.errorCode}</p> : null}
      </div>

      {handoff ? (
        <div className="space-y-2">
          {run.message ? (
            <p className="text-sm font-medium break-words text-amber-900">{run.message}</p>
          ) : null}
          {run.needsConfirm ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void act(() => rpc('run.confirm', { runId: run.runId }))}
            >
              继续
            </Button>
          ) : (
            <p className="text-xs text-amber-800">等待页面条件满足后自动继续</p>
          )}
        </div>
      ) : null}

      <div className="flex gap-2">
        {active ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void act(() => rpc('run.abort', { runId: run.runId }))}
          >
            中止
          </Button>
        ) : (
          <Button
            disabled={busy}
            onClick={() => void act(() => rpc('run.dismiss', { runId: run.runId }))}
          >
            清除
          </Button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
