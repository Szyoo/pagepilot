import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { matchesAnyGlob } from '../../shared/glob';
import { rpc } from '../../shared/rpc';
import { Badge, Button, Card, ErrorText } from '../../shared/ui/components';
import { useAction } from '../../shared/ui/useAction';
import { useBgState } from '../../shared/ui/useBgState';
import { RuleItem } from './RuleItem';

const CONNECTION_LABEL = {
  idle: '未连接',
  connecting: '连接中',
  connected: '已连接',
  error: '连接出错',
} as const;

interface ActiveTab {
  id?: number;
  windowId?: number;
  url?: string;
}

export function App() {
  const { state, error: stateError } = useBgState();
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [captured, setCaptured] = useState<number | null>(null);
  const capture = useAction();
  const panel = useAction();

  useEffect(() => {
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then(([t]) => setTab({ id: t?.id, windowId: t?.windowId, url: t?.url }))
      .catch(() => setTab({}));
  }, []);

  const rules = useMemo(() => {
    const url = tab?.url;
    if (!state || !url) return [];
    return state.rules.filter((r) => matchesAnyGlob(r.matchUrls, url));
  }, [state, tab?.url]);

  const doCapture = async () => {
    if (tab?.id === undefined) return;
    const tabId = tab.id;
    setCaptured(null);
    const res = await capture.run(() => rpc('capture.page', { tabId }));
    if (res) setCaptured(res.count);
  };

  const openPanel = () => {
    // sidePanel.open 需在用户手势内同步调用
    if (tab?.id === undefined) return;
    const target =
      tab.windowId !== undefined ? { tabId: tab.id, windowId: tab.windowId } : { tabId: tab.id };
    void panel.run(async () => {
      await browser.sidePanel.open(target);
      window.close();
    });
  };

  return (
    <main className="w-[360px] space-y-3 bg-slate-50 p-3 text-slate-900">
      <header className="flex items-center justify-between">
        <h1 className="text-base font-bold">PagePilot</h1>
        <div className="flex gap-1">
          <Button variant="ghost" onClick={openPanel} disabled={tab?.id === undefined}>
            打开侧边栏
          </Button>
          <Button variant="ghost" onClick={() => void browser.runtime.openOptionsPage()}>
            设置
          </Button>
        </div>
      </header>
      <ErrorText>{panel.error}</ErrorText>

      {!state ? (
        stateError ? (
          <ErrorText>{stateError}</ErrorText>
        ) : (
          <p role="status" className="text-sm text-slate-500">
            加载中…
          </p>
        )
      ) : (
        <>
          <Card className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>账号</span>
              {state.auth.status === 'signedIn' ? (
                <Badge tone="green">已登录</Badge>
              ) : (
                <>
                  <Badge tone="gray">未登录</Badge>
                  <Button variant="primary" onClick={() => void browser.runtime.openOptionsPage()}>
                    去设置页登录
                  </Button>
                </>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span>连接</span>
              <Badge
                tone={
                  state.connection.status === 'connected'
                    ? 'green'
                    : state.connection.status === 'error'
                      ? 'red'
                      : 'gray'
                }
              >
                {CONNECTION_LABEL[state.connection.status]}
              </Badge>
            </div>
            {state.connection.error ? <ErrorText>{state.connection.error}</ErrorText> : null}
          </Card>

          <section aria-labelledby="rules-title" className="space-y-2">
            <h2 id="rules-title" className="text-sm font-semibold text-slate-700">
              当前页面可用规则
            </h2>
            {rules.length === 0 ? (
              <p className="text-sm text-slate-500">当前页面没有匹配的规则。</p>
            ) : (
              rules.map((r) => <RuleItem key={r.id} rule={r} tabId={tab?.id} />)
            )}
          </section>

          <section className="space-y-1">
            <Button onClick={doCapture} disabled={capture.busy || tab?.id === undefined}>
              {capture.busy ? '抓取中…' : '抓取当前页面'}
            </Button>
            {captured !== null ? (
              <p role="status" className="text-sm text-green-700">
                已抓取 {captured} 个元素
              </p>
            ) : null}
            <ErrorText>{capture.error}</ErrorText>
          </section>
        </>
      )}
    </main>
  );
}
