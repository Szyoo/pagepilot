import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Locator, Step } from '../../schema/rule';
import { type RecordingView, rpc } from '../../shared/rpc';
import { Badge, Button, Card, ErrorText, inputClass } from '../../shared/ui/components';
import { useAction } from '../../shared/ui/useAction';

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
      return locatorText(step.target);
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
      return step.message;
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

  return (
    <li className="space-y-1 rounded-md border border-slate-200 bg-white p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-sm">
          <span className="mr-1 text-xs text-slate-500">{index + 1}.</span>
          <span className="font-medium">{TYPE_LABEL[step.type]}</span>
          <span className="ml-1 break-all text-xs text-slate-600">{stepSummary(step)}</span>
        </div>
        <Button
          variant="ghost"
          className="shrink-0 px-2 py-0.5 text-xs"
          onClick={() => onDelete(index)}
          aria-label={`删除第 ${index + 1} 步`}
        >
          删除
        </Button>
      </div>
      {editable ? (
        <div className="flex items-center gap-2">
          <input
            aria-label={`第 ${index + 1} 步的值`}
            className={`${inputClass} ${isPlaceholder(draft) ? 'border-purple-400 bg-purple-50 font-mono text-purple-800' : ''}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft !== current) onChangeValue(index, draft);
            }}
          />
          {isPlaceholder(draft) ? <Badge tone="blue">占位符</Badge> : null}
        </div>
      ) : null}
    </li>
  );
}

export function Recording({ recording }: { recording: RecordingView }) {
  const { busy, error, run } = useAction();

  const start = () =>
    void run(async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('找不到当前标签页');
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

  return (
    <section aria-labelledby="rec-title" className="space-y-2">
      <h2 id="rec-title" className="text-sm font-semibold text-slate-700">
        录制
      </h2>
      <Card className="space-y-2">
        {recording.status === 'idle' ? (
          <Button variant="primary" onClick={start} disabled={busy}>
            开始录制当前标签页
          </Button>
        ) : null}

        {recording.status === 'recording' ? (
          <div className="flex items-center justify-between gap-2">
            <p role="status" className="text-sm">
              录制中，已录 {recording.steps.length} 步
            </p>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => void run(() => rpc('recording.stop'))}
            >
              停止
            </Button>
          </div>
        ) : null}

        {recording.status === 'review' ? (
          <div className="space-y-2">
            <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
              上报前请检查输入值，敏感信息请改为 {'{{profile.x}}'} 占位符。
            </p>
            {recording.steps.length === 0 ? (
              <p className="text-sm text-slate-500">没有录到任何步骤。</p>
            ) : (
              <ol className="space-y-1.5">
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
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={busy || recording.steps.length === 0}
                onClick={() => void run(() => rpc('recording.submit'))}
              >
                上报
              </Button>
              <Button disabled={busy} onClick={() => void run(() => rpc('recording.discard'))}>
                丢弃
              </Button>
            </div>
          </div>
        ) : null}
        <ErrorText>{error}</ErrorText>
      </Card>
    </section>
  );
}
