import { browser } from 'wxt/browser';
import { type RuleView, type RunView, rpc } from '../../shared/rpc';
import { useAction } from '../../shared/ui/useAction';
import { startRule } from './actions';
import { describeError, formatClock, formatDuration, isActiveRun, RUN_STATUS } from './lib';
import { Badge, Btn, ErrorLine } from './parts';

export function RunCard({
  run,
  rule,
  now,
}: {
  run: RunView;
  /** 对应的规则（再运行时用）；规则已被移除时为 undefined */
  rule: RuleView | undefined;
  now: number;
}) {
  const { busy, error, run: act } = useAction();
  const active = isActiveRun(run);
  const handoff = run.status === 'handoff';
  const st = RUN_STATUS[run.status];
  const elapsed = formatDuration((run.endedAt ?? (active ? now : run.startedAt)) - run.startedAt);
  const pct = run.repeat
    ? Math.min(100, Math.round((run.repeat.attempt / Math.max(1, run.repeat.max)) * 100))
    : 0;

  const rerun = () => {
    if (!rule) return;
    void act(async () => {
      try {
        await browser.tabs.get(run.tabId);
      } catch {
        throw new Error('原来的标签页已经关闭，请到目标页面的「当前页」页签运行');
      }
      await startRule(rule, run.tabId);
    });
  };

  return (
    <article className={`card${handoff ? ' alert' : ''}`} aria-label={run.ruleName}>
      <div className="card-head">
        <h3 className="card-title ellipsis">{run.ruleName}</h3>
        <div className="badges">
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>
      </div>

      <dl className="meta">
        {run.stepNote ? (
          <div>
            <dt>{active ? '正在：' : '停在：'}</dt>
            <dd>
              {run.stepNote}
              {run.stepId ? <span className="muted small">（{run.stepId}）</span> : null}
            </dd>
          </div>
        ) : run.stepId ? (
          <div>
            <dt>当前步骤：</dt>
            <dd>{run.stepId}</dd>
          </div>
        ) : null}
        <div>
          <dt>开始于：</dt>
          <dd>
            {formatClock(run.startedAt)}，{active ? '已用时' : '用时'} {elapsed}
          </dd>
        </div>
      </dl>

      {run.repeat ? (
        <div>
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={run.repeat.max}
            aria-valuenow={run.repeat.attempt}
            aria-label="循环进度"
          >
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="small muted">
            第 {run.repeat.attempt} / 最多 {run.repeat.max} 轮
          </p>
        </div>
      ) : null}

      {run.errorCode ? (
        <p className="error-text">
          {describeError(run.errorCode)}
          {describeError(run.errorCode) !== run.errorCode ? (
            <span className="small muted">（{run.errorCode}）</span>
          ) : null}
        </p>
      ) : null}

      {handoff ? (
        <div className="banner">
          {run.message ? <p className="banner-title break">{run.message}</p> : null}
          {run.autoResume ? (
            <p className="small">页面条件满足后会自动继续，也可以手动点「继续」</p>
          ) : null}
          {!run.needsConfirm && !run.autoResume ? (
            <p className="small">等待页面条件满足后自动继续</p>
          ) : null}
          {run.needsConfirm ? (
            <Btn
              kind="primary"
              disabled={busy}
              onClick={() => void act(() => rpc('run.confirm', { runId: run.runId }))}
            >
              继续
            </Btn>
          ) : null}
        </div>
      ) : null}

      <div className="btn-row">
        {active ? (
          <Btn
            kind="danger"
            size="sm"
            disabled={busy}
            onClick={() => void act(() => rpc('run.abort', { runId: run.runId }))}
          >
            中止
          </Btn>
        ) : (
          <>
            <Btn
              size="sm"
              disabled={busy}
              onClick={() => void act(() => rpc('run.dismiss', { runId: run.runId }))}
            >
              清除
            </Btn>
            <Btn
              size="sm"
              disabled={busy || !rule}
              title={rule ? undefined : '规则已不存在'}
              onClick={rerun}
            >
              再运行一次
            </Btn>
          </>
        )}
      </div>
      <ErrorLine>{error}</ErrorLine>
    </article>
  );
}
