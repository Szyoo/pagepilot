import type { BgState, RuleView, RunStatus, RunView } from '../../shared/rpc';

export type PanelTab = 'page' | 'runs' | 'recording' | 'rules';

export const PANEL_TABS: readonly PanelTab[] = ['page', 'runs', 'recording', 'rules'];

export function isPanelTab(v: unknown): v is PanelTab {
  return typeof v === 'string' && (PANEL_TABS as readonly string[]).includes(v);
}

const ERROR_TEXT: Record<string, string> = {
  TARGET_NOT_FOUND: '找不到页面上的元素（页面可能改版了）',
  TIMEOUT: '等待超时',
  ASSERT_FAILED: '页面状态和预期不符',
  NAVIGATION_FAILED: '页面跳转失败',
  PERMISSION_DENIED: '缺少网站访问权限',
  DATA_MISSING: '缺少本地数据（去设置页的保险库补充）',
  SECRET_ORIGIN_DENIED: '这个凭据不允许在当前网站使用',
  REPEAT_EXHAUSTED: '反复尝试后条件仍未满足',
  USER_ABORTED: '已被中止',
  INTERNAL: '内部错误',
};

/** 错误码转成人话，未知的错误码原样返回 */
export function describeError(code: string): string {
  return ERROR_TEXT[code] ?? code;
}

export type StatusTone = 'gray' | 'yellow' | 'red' | 'green';

const CHANNEL_NAME = { sse: 'SSE', websocket: 'WebSocket', poll: '轮询' } as const;

export function isActiveRun(run: Pick<RunView, 'status'>): boolean {
  return run.status === 'running' || run.status === 'handoff';
}

/** 页头状态：未登录 > 连接出错 > 有运行等你处理 > 连接中 > 已连接 */
export function connectionStatus(state: Pick<BgState, 'auth' | 'connection' | 'runs'>): {
  tone: StatusTone;
  text: string;
} {
  if (state.auth.status !== 'signedIn') return { tone: 'gray', text: '未登录' };
  const { status, channel } = state.connection;
  if (status === 'error') return { tone: 'red', text: '连接出错' };
  if (state.runs.some((r) => r.status === 'handoff')) return { tone: 'yellow', text: '等你处理' };
  if (status === 'connecting') return { tone: 'yellow', text: '连接中…' };
  if (status === 'connected') {
    return { tone: 'green', text: channel ? `已连接 · ${CHANNEL_NAME[channel]}` : '已连接' };
  }
  return { tone: 'gray', text: '未连接' };
}

const ADMIN_HASH: Record<PanelTab, string> = {
  page: '',
  runs: '#runs',
  recording: '#recordings',
  rules: '#rules',
};

/** 后台管理页地址：后台地址的 origin + `/`，按页签带 hash；没有或非法的地址返回 null */
export function adminUrl(backendUrl: string | undefined, tab: PanelTab = 'page'): string | null {
  if (!backendUrl) return null;
  let url: URL;
  try {
    url = new URL(backendUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return `${url.origin}/${ADMIN_HASH[tab]}`;
}

/** 毫秒转成“42 秒”“3 分 05 秒”“1 小时 02 分” */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h} 小时 ${two(m)} 分`;
  if (m > 0) return `${m} 分 ${two(s)} 秒`;
  return `${s} 秒`;
}

/** 时间戳转成本地 时:分:秒 */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** 按名称或匹配网址过滤规则（不区分大小写），空查询返回全部 */
export function filterRules(rules: RuleView[], query: string): RuleView[] {
  const q = query.trim().toLowerCase();
  if (!q) return rules;
  return rules.filter(
    (r) => r.name.toLowerCase().includes(q) || r.matchUrls.some((u) => u.toLowerCase().includes(q)),
  );
}

/** 进行中的置顶，其余按开始时间倒序 */
export function sortRuns(runs: RunView[]): RunView[] {
  return [...runs].sort((a, b) => {
    const d = Number(isActiveRun(b)) - Number(isActiveRun(a));
    return d !== 0 ? d : b.startedAt - a.startedAt;
  });
}

export const RUN_STATUS: Record<
  RunStatus,
  { label: string; tone: 'blue' | 'yellow' | 'green' | 'red' | 'gray' }
> = {
  running: { label: '运行中', tone: 'blue' },
  handoff: { label: '等你处理', tone: 'yellow' },
  succeeded: { label: '成功', tone: 'green' },
  failed: { label: '失败', tone: 'red' },
  aborted: { label: '已中止', tone: 'gray' },
  handedOff: { label: '已交还', tone: 'gray' },
};

/** 所需本地数据摘要 */
export function requiresText(rule: Pick<RuleView, 'requires'>): string {
  const parts: string[] = [];
  if (rule.requires.profile.length) parts.push(`个人信息：${rule.requires.profile.join('、')}`);
  if (rule.requires.secret.length) parts.push(`凭据：${rule.requires.secret.join('、')}`);
  return parts.join('；') || '无';
}

/** 网址的主机名，解析失败时返回原文 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
