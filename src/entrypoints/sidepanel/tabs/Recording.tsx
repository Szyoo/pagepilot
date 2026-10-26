import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Locator, Step } from '../../../schema/rule';
import { type RecordingView, rpc } from '../../../shared/rpc';
import { ensureTabAccess } from '../../../shared/ui/tabAccess';
import { useAction } from '../../../shared/ui/useAction';
import { useNow } from '../hooks';
import { formatDuration } from '../lib';
import { Badge, Btn, ErrorLine } from '../parts';
import { StepGuide } from '../StepGuide';

const TYPE_LABEL: Record<Step['type'], string> = {
  open: '打开',
  click: '点击',
  fill: '填写',
  select: '选择',
  check: '勾选',
  press: '按键',
  waitFor: '等待',
  switchTab: '切换标签页',
  handoff: '交还',
  assert: '断言',
  extract: '提取',
  if: '条件',
  repeat: '循环',
};

function locatorText(l: Locator | undefined): string {
  const s = l?.strategies[0];
  return s ? `${s.kind}: ${s.value}` : '';
}

function stepSummary(step: Step): string {
  switch (step.type) {
    case 'open':
      return step.url;
    case 'click':
    case 'extract':
    case 'fill':
    case 'select':
      return locatorText(step.target);
    case 'check':
      return `${locatorText(step.target)}（${step.checked ? '勾选' : '取消勾选'}）`;
    case 'press':
      return step.target ? `${step.key} @ ${locatorText(step.target)}` : step.key;
    case 'switchTab':
      return step.urlPattern;
    case 'handoff':
      return step.message || '请输入验证码';
    default:
      return '';
  }
}

const isPlaceholder = (v: string) => v.trim().startsWith('{{');

function StepRow({
  step,
  index,
  onChangeValue,
  onDelete,
}: {
  step: Step;
  index: number;
  onChangeValue: (index: number, value: string) => void;
  onDelete: (index: number) => void;
}) {
  const editable = step.type === 'fill' || step.type === 'select';
  const current = editable ? step.value : '';
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const ph = isPlaceholder(draft);

  return (
    <li className={`step${step.type === 'handoff' ? ' handoff' : ''}`}>
      <div className="step-head">
        <div style={{ minWidth: 0 }}>
          <span className="step-no">{index + 1}.</span>
          <span className="step-type">{TYPE_LABEL[step.type]}</span>
          <span className="step-sum">
            {step.type === 'handoff' ? `：${stepSummary(step)}` : stepSummary(step)}
          </span>
        </div>
        <Btn
          kind="ghost"
          size="sm"
          inline
          onClick={() => onDelete(index)}
          aria-label={`删除第 ${index + 1} 步`}
        >
          删除
        </Btn>
      </div>
      {editable ? (
        <div className="btn-row" style={{ alignItems: 'center' }}>
          <input
            aria-label={`第 ${index + 1} 步的值`}
            className={`input${ph ? ' ph' : ''}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft !== current) onChangeValue(index, draft);
            }}
          />
          {ph ? <Badge tone="blue">占位符</Badge> : null}
        </div>
      ) : null}
    </li>
  );
}

export function Recording({
  recording,
  flash,
  submitted,
  setSubmitted,
  adminHref,
  onOpenAdmin,
}: {
  recording: RecordingView;
  flash: (text: string, tone?: 'ok' | 'bad') => void;
  submitted: boolean;
  setSubmitted: (v: boolean) => void;
  adminHref: string | null;
  onOpenAdmin: () => void;
}) {
  const { busy, error, run } = useAction();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const recording_ = recording.status === 'recording';
  const now = useNow(recording_);

  // 状态离开 review 后收起丢弃确认
  useEffect(() => {
    if (recording.status !== 'review') setConfirmDiscard(false);
  }, [recording.status]);

  const start = () =>
    void run(async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('找不到当前标签页');
      await ensureTabAccess(tab);
      setSubmitted(false);
      await rpc('recording.start', { tabId: tab.id });
    });

  const setSteps = (steps: Step[]) => void run(() => rpc('recording.setSteps', { steps }));
  const changeValue = (index: number, value: string) =>
    setSteps(
      recording.steps.map((s, i) =>
        i === index && (s.type === 'fill' || s.type === 'select') ? { ...s, value } : s,
      ),
    );
  const remove = (index: number) => setSteps(recording.steps.filter((_, i) => i !== index));

  const submit = () =>
    void run(async () => {
      await rpc('recording.submit');
      setSubmitted(true);
      flash('已上报，去管理页生成规则');
    });

  const guide =
    recording.status === 'idle' ? (submitted ? 5 : 1) : recording.status === 'recording' ? 2 : 3;

  return (
    <>
      <StepGuide current={guide} />

      {submitted && recording.status === 'idle' ? (
        <div className="banner ok" role="status">
          <p className="banner-title">已上报</p>
          <p>到管理页的「录制」里就能生成规则了。</p>
          <Btn kind="primary" size="sm" disabled={adminHref === null} onClick={onOpenAdmin}>
            打开管理页
          </Btn>
        </div>
      ) : null}

      {recording.status === 'idle' ? (
        <>
          <p className="muted">
            开始后，在当前页面上照常操作一遍；点击、填写、选择等动作都会被记录下来。
          </p>
          <Btn kind="primary" size="main" onClick={start} disabled={busy}>
            开始录制当前页面
          </Btn>
        </>
      ) : null}

      {recording_ ? (
        <div className="card">
          <p className="rec-line" role="status">
            <span className="dot rec" aria-hidden="true" />
            录制中
          </p>
          <p className="muted">
            已录 {recording.steps.length} 步
            {recording.startedAt !== undefined
              ? `，已录 ${formatDuration(now - recording.startedAt)}`
              : ''}
          </p>
          <Btn kind="danger" disabled={busy} onClick={() => void run(() => rpc('recording.stop'))}>
            停止录制
          </Btn>
        </div>
      ) : null}

      {recording.status === 'review' ? (
        <>
          <div className="banner">
            <p>上报前请检查输入值，敏感信息请改为 {'{{profile.x}}'} 占位符。</p>
          </div>
          {recording.steps.length === 0 ? (
            <p className="muted">没有录到任何步骤。</p>
          ) : (
            <ol style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {recording.steps.map((s, i) => (
                <StepRow
                  key={s.id}
                  step={s}
                  index={i}
                  onChangeValue={changeValue}
                  onDelete={remove}
                />
              ))}
            </ol>
          )}
          {confirmDiscard ? (
            <div className="confirm-box" role="alert">
              <p>丢弃后这次录制的 {recording.steps.length} 个步骤无法恢复，确定丢弃吗？</p>
              <div className="btn-row">
                <Btn
                  kind="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => rpc('recording.discard'))}
                >
                  确定丢弃
                </Btn>
                <Btn size="sm" onClick={() => setConfirmDiscard(false)}>
                  取消
                </Btn>
              </div>
            </div>
          ) : (
            <div className="btn-row">
              <Btn kind="primary" disabled={busy || recording.steps.length === 0} onClick={submit}>
                上报
              </Btn>
              <Btn disabled={busy} onClick={() => setConfirmDiscard(true)}>
                丢弃
              </Btn>
            </div>
          )}
        </>
      ) : null}
      <ErrorLine>{error}</ErrorLine>
    </>
  );
}
