import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { RunView } from '../../shared/rpc';
import { useBgState } from '../../shared/ui/useBgState';
import { AssistPanel } from './AssistPanel';
import { openUrl } from './actions';
import { Banners } from './Banners';
import { Flash, useFlash } from './Flash';
import { useActiveTab, useBackendUrl } from './hooks';
import { adminUrl, connectionStatus, isPanelTab, type PanelTab } from './lib';
import { ErrorLine } from './parts';
import { TopBar } from './TopBar';
import { CurrentPage } from './tabs/CurrentPage';
import { Recording } from './tabs/Recording';
import { Rules } from './tabs/Rules';
import { Runs } from './tabs/Runs';

const STORAGE_KEY = 'sidepanel:tab';

const TAB_LABEL: Record<PanelTab, string> = {
  page: '当前页',
  runs: '运行',
  recording: '录制',
  rules: '规则',
};
const TAB_ORDER: PanelTab[] = ['page', 'runs', 'recording', 'rules'];

export function App() {
  const { state, error } = useBgState();
  const tab = useActiveTab();
  const backendUrl = useBackendUrl();
  const { message, flash } = useFlash();
  const [current, setCurrent] = useState<PanelTab>('page');
  const [submitted, setSubmitted] = useState(false);
  /** 打开「请 AI 看看」时那一刻的运行（之后运行继续或结束，面板里的对话不受影响） */
  const [assist, setAssist] = useState<RunView | null>(null);
  const restored = useRef(false);
  const prevStatus = useRef(new Map<string, string>());

  const selectTab = useCallback((next: PanelTab) => {
    setCurrent(next);
    restored.current = true;
    void browser.storage.session.set({ [STORAGE_KEY]: next }).catch(() => undefined);
  }, []);

  // 启动时恢复上次的页签（用户在恢复完成前已手动选择则不覆盖）
  useEffect(() => {
    browser.storage.session
      .get(STORAGE_KEY)
      .then((res) => {
        const saved = res[STORAGE_KEY];
        if (!restored.current && isPanelTab(saved)) setCurrent(saved);
      })
      .catch(() => undefined);
  }, []);

  // 有运行刚进入交还时自动切到「运行」页签，只在状态变化的那一刻切一次
  useEffect(() => {
    if (!state) return;
    const prev = prevStatus.current;
    let entered = false;
    for (const r of state.runs) {
      if (r.status === 'handoff' && prev.get(r.runId) !== 'handoff') entered = true;
    }
    prevStatus.current = new Map(state.runs.map((r) => [r.runId, r.status]));
    if (entered) selectTab('runs');
  }, [state, selectTab]);

  const adminHref = adminUrl(backendUrl, current);
  const openAdmin = () => {
    if (adminHref) void openUrl(adminHref);
  };
  const recordingAdminHref = adminUrl(backendUrl, 'recording');
  const openRecordingAdmin = () => {
    if (recordingAdminHref) void openUrl(recordingAdminHref);
  };

  const status = useMemo(() => (state ? connectionStatus(state) : null), [state]);
  const activeRuns = state?.runs.filter((r) => r.status === 'running' || r.status === 'handoff');
  const hasHandoff = state?.runs.some((r) => r.status === 'handoff') ?? false;
  const badge: Record<PanelTab, { n: number; kind: 'info' | 'alert' | '' } | null> = {
    page: null,
    runs: activeRuns?.length ? { n: activeRuns.length, kind: hasHandoff ? 'alert' : 'info' } : null,
    recording: null,
    rules: state?.rules.length ? { n: state.rules.length, kind: '' } : null,
  };

  return (
    <div className="app">
      <TopBar
        tone={status?.tone ?? 'gray'}
        text={status?.text ?? '加载中…'}
        adminHref={adminHref}
        onOpenAdmin={openAdmin}
      />
      {state ? <Banners state={state} /> : null}
      <div className="tabs" role="tablist" aria-label="侧边栏页签">
        {TAB_ORDER.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`tab-${t}`}
            aria-selected={current === t}
            aria-controls="panel-body"
            className="tab"
            onClick={() => selectTab(t)}
          >
            {TAB_LABEL[t]}
            {badge[t] ? <span className={`count ${badge[t].kind}`}>{badge[t].n}</span> : null}
          </button>
        ))}
      </div>
      <main className="body" id="panel-body" role="tabpanel" aria-labelledby={`tab-${current}`}>
        {!state ? (
          error ? (
            <ErrorLine>{error}</ErrorLine>
          ) : (
            <p role="status" className="loading">
              加载中…
            </p>
          )
        ) : current === 'page' ? (
          <CurrentPage
            state={state}
            tab={tab}
            flash={flash}
            onRecordingStarted={() => selectTab('recording')}
          />
        ) : current === 'runs' ? (
          <Runs state={state} onAssist={setAssist} />
        ) : current === 'recording' ? (
          <Recording
            recording={state.recording}
            flash={flash}
            submitted={submitted}
            setSubmitted={setSubmitted}
            adminHref={recordingAdminHref}
            onOpenAdmin={openRecordingAdmin}
          />
        ) : (
          <Rules state={state} adminHref={adminHref} onOpenAdmin={openAdmin} />
        )}
      </main>
      <Flash message={message} />
      {assist ? <AssistPanel run={assist} onClose={() => setAssist(null)} /> : null}
    </div>
  );
}
