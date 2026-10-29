import { matchesAnyGlob } from '../../../shared/glob';
import { type BgState, rpc } from '../../../shared/rpc';
import { ensureTabAccess } from '../../../shared/ui/tabAccess';
import { useAction } from '../../../shared/ui/useAction';
import { openRulePage } from '../actions';
import type { ActiveTab } from '../hooks';
import { hostOf } from '../lib';
import { Btn, Empty, ErrorLine } from '../parts';
import { RuleCard } from '../RuleCard';

export function CurrentPage({
  state,
  tab,
  flash,
  onRecordingStarted,
}: {
  state: BgState;
  tab: ActiveTab | null;
  flash: (text: string, tone?: 'ok' | 'bad') => void;
  onRecordingStarted: () => void;
}) {
  const capture = useAction();
  const record = useAction();
  const url = tab?.url;
  const tabId = tab?.id;
  const rules = url ? state.rules.filter((r) => r.enabled && matchesAnyGlob(r.matchUrls, url)) : [];
  // 当前页没有规则时，列出可以一键前往的规则
  const elsewhere = state.rules.filter((r) => r.enabled && r.entryUrl);
  const jump = useAction();
  const recordingBusy = state.recording.status !== 'idle';

  const doCapture = () => {
    if (!tab || tabId === undefined) return;
    void capture.run(async () => {
      await ensureTabAccess(tab);
      const res = await rpc('capture.page', { tabId });
      flash(`已抓取 ${res.count} 个元素并上报`);
    });
  };

  const doRecord = () => {
    if (!tab || tabId === undefined) return;
    void record.run(async () => {
      await ensureTabAccess(tab);
      await rpc('recording.start', { tabId });
      onRecordingStarted();
    });
  };

  return (
    <>
      <div className="page-info">
        {url ? (
          <>
            <p className="page-host ellipsis">{hostOf(url)}</p>
            <p className="small muted ellipsis" title={url}>
              {url}
            </p>
          </>
        ) : (
          <p className="muted">没有可识别的当前页面</p>
        )}
      </div>

      {rules.length === 0 ? (
        <>
          <Empty title="这个页面还没有规则" sub="可以先录制一遍操作，再到管理页生成规则" />
          {elsewhere.length > 0 ? (
            <section className="card" aria-label="去规则的页面">
              <h3 className="section-title">去规则的页面</h3>
              <ul style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {elsewhere.map((r) => (
                  <li key={r.id} className="open-row">
                    <span className="ellipsis" title={r.entryUrl}>
                      {r.name}
                    </span>
                    <Btn
                      size="sm"
                      disabled={jump.busy}
                      onClick={() => void jump.run(() => openRulePage(r.entryUrl))}
                    >
                      打开页面
                    </Btn>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : (
        <ul className="list" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rules.map((r) => (
            <li key={r.id}>
              <RuleCard rule={r} variant="current" tabId={tabId} />
            </li>
          ))}
        </ul>
      )}

      <div className="btn-row">
        <Btn onClick={doCapture} disabled={capture.busy || tabId === undefined}>
          {capture.busy ? '抓取中…' : '抓取当前页面'}
        </Btn>
        <Btn
          onClick={doRecord}
          disabled={record.busy || tabId === undefined || recordingBusy}
          title={recordingBusy ? '已经有一个录制在进行或待检查' : undefined}
        >
          {record.busy ? '准备中…' : '开始录制'}
        </Btn>
      </div>
      <ErrorLine>{capture.error ?? record.error ?? jump.error}</ErrorLine>
    </>
  );
}
