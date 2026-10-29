import { useState } from 'react';
import { browser } from 'wxt/browser';
import {
  type ResolveAction,
  type RuleView,
  type RunView,
  rpc,
  type StuckView,
} from '../../shared/rpc';
import { useAction } from '../../shared/ui/useAction';
import { openRulePage, startRule } from './actions';
import {
  describeError,
  failedStepText,
  formatClock,
  formatDuration,
  isActiveRun,
  RUN_STATUS,
  resumeLabel,
  stepOptionLabel,
} from './lib';
import { Badge, Btn, ErrorLine } from './parts';

export function RunCard({
  run,
  rule,
  now,
  onAssist,
}: {
  run: RunView;
  /** 对应的规则（再运行时用）；规则已被移除时为 undefined */
  rule: RuleView | undefined;
  now: number;
  /** 卡住时打开「请 AI 看看」面板 */
  onAssist?: ((run: RunView) => void) | undefined;
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

      {handoff && run.stuck ? (
        <StuckPanel
          stuck={run.stuck}
          busy={busy}
          onAssist={onAssist ? () => onAssist(run) : undefined}
          resolve={(action, index) =>
            void act(() =>
              rpc('run.resolve', {
                runId: run.runId,
                action,
                ...(index !== undefined ? { index } : {}),
              }),
            )
          }
        />
      ) : null}

      {handoff && !run.stuck ? (
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
        <Btn
          size="sm"
          disabled={busy}
          title="切到这条规则所在的标签页，标签页已关闭时打开规则的页面"
          onClick={() => void act(() => openRulePage(rule?.entryUrl, run.tabId))}
        >
          打开页面
        </Btn>
      </div>
      <ErrorLine>{error}</ErrorLine>
    </article>
  );
}

/** 步骤失败暂停：说明失败的步骤，并让用户选择从哪一步继续 */
function StuckPanel({
  stuck,
  busy,
  onAssist,
  resolve,
}: {
  stuck: StuckView;
  busy: boolean;
  onAssist: (() => void) | undefined;
  resolve: (action: ResolveAction, index?: number) => void;
}) {
  // 用户没动过下拉时跟随建议的位置
  const [picked, setPicked] = useState<number | null>(null);
  const selected = picked ?? stuck.suggestedIndex;
  const total = stuck.steps.length;
  return (
    <div className="banner stuck">
      <p className="banner-title break">{failedStepText(stuck)}失败</p>
      <p className="small break">
        {stuck.errorText ?? describeError(stuck.errorCode)}
        <span className="muted">（{stuck.errorCode}）</span>
      </p>
      <p className="small">可以在页面上手动处理，再选择从哪一步继续。</p>
      <Btn kind="primary" disabled={busy} onClick={() => resolve('continue')}>
        {resumeLabel(stuck)}
      </Btn>
      <div className="btn-row">
        <Btn size="sm" disabled={busy} onClick={() => resolve('retry')}>
          重试这一步
        </Btn>
        <Btn size="sm" disabled={busy} onClick={() => resolve('skip')}>
          跳过这一步
        </Btn>
      </div>
      <label className="stuck-goto">
        <span className="small">改从哪一步开始</span>
        <select
          className="input"
          value={selected}
          onChange={(e) => setPicked(Number(e.target.value))}
        >
          {stuck.steps.map((st) => (
            <option key={st.index} value={st.index}>
              {stepOptionLabel(st)}
              {st.index === stuck.suggestedIndex ? '（建议）' : ''}
            </option>
          ))}
          <option value={total}>
            这一段已完成{total === stuck.suggestedIndex ? '（建议）' : ''}
          </option>
        </select>
      </label>
      <Btn size="sm" disabled={busy} onClick={() => resolve('goto', selected)}>
        从这一步继续
      </Btn>
      {onAssist ? (
        <Btn size="sm" kind="ghost" onClick={onAssist}>
          请 AI 看看
        </Btn>
      ) : null}
    </div>
  );
}
