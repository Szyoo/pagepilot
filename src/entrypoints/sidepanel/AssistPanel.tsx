import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { ASSIST_INSTRUCTIONS, buildAssistPrompt } from '../../shared/assist';
import {
  type BridgeClient,
  type BridgeStatus,
  bridgeStatus,
  createBridgeClient,
} from '../../shared/bridge';
import { DEFAULT_ASSIST_SCOPE } from '../../shared/bridge-discovery';
import type { InspectElement } from '../../shared/content-api';
import { originPatternOf } from '../../shared/glob';
import { type RunView, rpc } from '../../shared/rpc';
import { loadSettings } from '../../shared/settings';
import { useAction } from '../../shared/ui/useAction';
import { mountBridgeWidget } from '../../vendor/claude-bridge/bridge-widget.js';
import '../../vendor/claude-bridge/bridge-widget.css';
import { marked } from 'marked';
import { openUrl } from './actions';
import { Btn, ErrorLine } from './parts';

// 聊天组件渲染回复时，若页面上有全局 marked 就按 Markdown 渲染（它会先转义 HTML 再解析），否则只显示纯文本
(globalThis as { marked?: typeof marked }).marked = marked;

interface Conn {
  bridgeUrl: string | null;
  /** claude-bridge 的 scope（后台下发，缺省 pagepilot），worker 侧对应一个无工具、不联网的 profile */
  scope: string;
  portalUrl: string | undefined;
  /** 已经拥有 bridge 站点的访问权限（点击时不必再申请） */
  hasPermission: boolean;
}

type Status = BridgeStatus | 'checking' | 'discovering';

/** 截下运行所在标签页的可见区域；该标签页必须是所在窗口的活动标签页 */
async function captureRunTab(tabId: number): Promise<Blob> {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('运行所在的标签页已经关闭');
  if (!tab.active)
    throw new Error('请先切到运行所在的标签页，再开始分析（截图只能截前台的标签页）');
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
    format: 'jpeg',
    quality: 70,
  });
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

/** 运行卡住时的 AI 面板：确认要发送的内容后，把中断的上下文交给 AI，之后用户可以在组件里继续追问 */
export function AssistPanel({ run, onClose }: { run: RunView; onClose: () => void }) {
  const [conn, setConn] = useState<Conn | null>(null);
  const [status, setStatus] = useState<Status>('discovering');
  const [shot, setShot] = useState(false);
  const [chat, setChat] = useState<{
    client: BridgeClient;
    thread: string;
    shot: boolean;
    scope: string;
  } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const start = useAction();

  const check = (bridgeUrl: string | null) => {
    setStatus('checking');
    void bridgeStatus(bridgeUrl ?? undefined).then(setStatus);
  };

  useEffect(() => {
    let alive = true;
    // 面板打开时先把地址与权限状态都准备好，点「开始分析」时才能立即发起权限申请（需要用户手势）
    void (async () => {
      const s = await loadSettings();
      const info = await rpc('ai.bridge').catch(() => null);
      const bridgeUrl = info?.bridgeUrl ?? null;
      const origin = bridgeUrl ? originPatternOf(`${bridgeUrl}/`) : null;
      const hasPermission = origin
        ? await browser.permissions.contains({ origins: [origin] }).catch(() => false)
        : false;
      if (!alive) return;
      setConn({
        bridgeUrl,
        scope: info?.scope ?? DEFAULT_ASSIST_SCOPE,
        portalUrl: s.portalUrl ?? s.backendUrl,
        hasPermission,
      });
      if (!bridgeUrl) return setStatus('notConfigured');
      // 还没有站点权限时跨域请求必然失败，不预检查；点「开始分析」授权后再检查
      if (!hasPermission) return setStatus('ok');
      setStatus('checking');
      void bridgeStatus(bridgeUrl).then((st) => alive && setStatus(st));
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 对话开始后挂载 claude-bridge 的聊天组件，关闭面板时销毁
  useEffect(() => {
    const el = host.current;
    if (!chat || !el) return;
    const widget = mountBridgeWidget(el, chat.client, {
      scope: chat.scope,
      showThreads: false,
      fill: true,
      locale: 'zh',
      title: '请 AI 看看',
      prefsKey: 'pagepilot',
      voice: false,
    });
    void widget.openThread(chat.thread);
    return () => widget.destroy();
  }, [chat]);

  const stuck = run.stuck;

  const begin = () => {
    const base = conn?.bridgeUrl;
    if (!base || !stuck) {
      setStatus('notConfigured');
      return;
    }
    // 网站访问权限需要用户手势：必须在点击处理函数里、任何 await 之前发起
    // 截图（tabs.captureVisibleTab）只认 <all_urls> 或 activeTab，网站权限不够，勾选时一并申请
    const withShot = shot;
    const origin = originPatternOf(`${base}/`);
    const origins = [
      ...(origin && !conn?.hasPermission ? [origin] : []),
      ...(withShot ? ['<all_urls>'] : []),
    ];
    const granted =
      origins.length > 0 ? browser.permissions.request({ origins }) : Promise.resolve(true);
    const scope = conn?.scope ?? DEFAULT_ASSIST_SCOPE;
    void start.run(async () => {
      if (!(await granted)) {
        throw new Error(
          withShot
            ? '需要允许访问 AI 服务的网站与截图所需的权限才能使用；可以不勾选截图再试'
            : '需要允许访问 AI 服务的网站才能使用',
        );
      }
      const st = await bridgeStatus(base);
      setStatus(st);
      if (st !== 'ok') return;
      const client = createBridgeClient(base);
      // 截图最先做，尽量截到用户看到的那一刻
      const image = withShot ? await captureRunTab(run.tabId) : null;
      const pageUrl = await browser.tabs
        .get(run.tabId)
        .then((t) => t.url)
        .catch(() => undefined);
      let elements: InspectElement[] | undefined;
      try {
        elements = (await rpc('capture.inspect', { tabId: run.tabId })).elements;
      } catch {
        elements = undefined; // 页面不可注入或已关闭：不带元素概要
      }
      const files = image ? [(await client.upload(image, { name: 'page.jpg' })).id] : [];
      const prompt = buildAssistPrompt({
        ruleName: run.ruleName,
        stuck,
        pageUrl,
        elements,
        screenshot: files.length > 0,
      });
      const res = await client.send(prompt, {
        scope,
        newThread: true,
        files,
        options: { instructions: ASSIST_INSTRUCTIONS },
      });
      setChat({ client, thread: res.thread, shot: files.length > 0, scope });
    });
  };

  return (
    <section className="assist" aria-label="请 AI 看看">
      <header className="assist-head">
        <Btn size="sm" kind="ghost" inline onClick={onClose}>
          ← 返回
        </Btn>
        <div className="assist-title ellipsis">
          <strong>请 AI 看看</strong>
          <span className="muted small ellipsis">{run.ruleName}</span>
        </div>
      </header>

      {chat ? (
        <p className="assist-sent small muted">
          已发送：规则名称、失败步骤与附近步骤、页面地址（不含查询串）与可见元素概要
          {chat.shot ? '、页面截图' : ''}。输入框里的内容与本地数据不会发送。
        </p>
      ) : (
        <div className="assist-setup">
          <p className="small">
            会把规则名称、失败的步骤与前后几步、当前页面地址（不含查询串）和页面上可见元素的概要发给
            AI。输入框里的内容、本地数据与凭据不会发送。
          </p>
          <label className="assist-check">
            <input
              type="checkbox"
              checked={shot}
              onChange={(e) => setShot(e.target.checked)}
              disabled={start.busy}
            />
            <span>附上当前页面截图（可能包含页面上的个人信息）</span>
          </label>
          {shot ? (
            <p className="small muted">
              浏览器要求截图的扩展拥有「访问所有网站」的权限，第一次使用时会弹出申请；不想授予可以不勾选。
            </p>
          ) : null}
          <AssistStatus
            status={status}
            portalUrl={conn?.portalUrl}
            onRetry={() => check(conn?.bridgeUrl ?? null)}
          />
          <Btn
            kind="primary"
            disabled={
              start.busy ||
              !stuck ||
              status === 'checking' ||
              status === 'discovering' ||
              status === 'notConfigured'
            }
            onClick={begin}
          >
            {start.busy ? '正在发送…' : '开始分析'}
          </Btn>
          <ErrorLine>{start.error}</ErrorLine>
        </div>
      )}

      <div className="assist-chat" ref={host} hidden={!chat} />
    </section>
  );
}

function AssistStatus({
  status,
  portalUrl,
  onRetry,
}: {
  status: Status;
  portalUrl: string | undefined;
  onRetry: () => void;
}) {
  if (status === 'discovering') {
    return (
      <p role="status" className="small muted">
        正在连接 AI 服务…
      </p>
    );
  }
  if (status === 'checking') {
    return (
      <p role="status" className="small muted">
        正在检查 AI 服务…
      </p>
    );
  }
  if (status === 'notConfigured') {
    return (
      <div className="banner" role="alert">
        <p className="banner-title">后台还没有接入 AI 服务</p>
        <p className="small">请联系后台管理员接入 AI 服务；接入后重新打开这个面板即可。</p>
      </div>
    );
  }
  if (status === 'signedOut') {
    return (
      <div className="banner" role="alert">
        <p className="banner-title">请先在普通网页里登录门户</p>
        <p className="small">AI 服务用门户的登录状态识别你。登录后回到这里点「重新检查」。</p>
        <div className="btn-row">
          {portalUrl ? (
            <Btn size="sm" kind="primary" onClick={() => void openUrl(portalUrl)}>
              打开门户
            </Btn>
          ) : null}
          <Btn size="sm" onClick={onRetry}>
            重新检查
          </Btn>
        </div>
      </div>
    );
  }
  if (status === 'unavailable') {
    return (
      <div className="banner" role="alert">
        <p className="banner-title">AI 服务暂时连不上</p>
        <p className="small">可能是网络问题或服务未启动，稍后再试。</p>
        <Btn size="sm" onClick={onRetry}>
          重新检查
        </Btn>
      </div>
    );
  }
  return null;
}
