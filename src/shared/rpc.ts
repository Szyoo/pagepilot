import { browser } from 'wxt/browser';
import type { LocalData } from '../schema/profile';
import type { Rule, Step } from '../schema/rule';

/** 界面看到的规则摘要 */
export interface RuleView {
  id: string;
  name: string;
  version: number;
  enabled: boolean;
  trigger: Rule['trigger'];
  inputMode: Rule['inputMode'];
  matchUrls: string[];
  requires: Rule['requires'];
  stepCount: number;
  /** 规则（的匹配范围、所需数据、输入方式）是否已被用户确认 */
  approved: boolean;
  /** trigger 为 auto 的规则是否已被用户开启自动运行 */
  autoEnabled: boolean;
}

export type RunStatus = 'running' | 'handoff' | 'succeeded' | 'failed' | 'aborted' | 'handedOff';

export interface RunView {
  runId: string;
  ruleId: string;
  ruleName: string;
  tabId: number;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  /** 当前步骤 id */
  stepId?: string;
  /** 交还时显示给用户的提示 */
  message?: string;
  /** repeat 进度 */
  repeat?: { attempt: number; max: number };
  /** 为 true 时提示用户在步骤完成后点「继续」；false 表示等待页面条件自动继续 */
  needsConfirm?: boolean;
  errorCode?: string;
}

export interface RecordingView {
  status: 'idle' | 'recording' | 'review';
  tabId?: number;
  startedAt?: number;
  steps: Step[];
}

export interface BgState {
  auth: { status: 'signedOut' | 'signedIn'; userId?: string };
  connection: {
    status: 'idle' | 'connecting' | 'connected' | 'error';
    channel?: 'websocket' | 'sse' | 'poll';
    error?: string;
  };
  rules: RuleView[];
  runs: RunView[];
  recording: RecordingView;
}

export interface RpcMethods {
  'state.get': { params: undefined; result: BgState };
  /** 用门户账号登录；调用前界面需先申请 `auth.origins` 返回的网站访问权限（用户手势） */
  'auth.login': { params: { username: string; password: string }; result: undefined };
  /** 登录与同步所需的网站访问权限（门户与后台所在站点，match pattern） */
  'auth.origins': { params: undefined; result: string[] };
  'auth.logout': { params: undefined; result: undefined };

  'vault.get': { params: undefined; result: LocalData };
  'vault.save': { params: LocalData; result: undefined };
  /** 导出明文 JSON 备份 */
  'vault.export': { params: undefined; result: string };
  /** 导入备份，替换当前用户的本地数据 */
  'vault.import': { params: { backup: string }; result: undefined };

  'run.start': { params: { ruleId: string; tabId: number }; result: { runId: string } };
  'run.abort': { params: { runId: string }; result: undefined };
  /** 交还后用户点「继续」 */
  'run.confirm': { params: { runId: string }; result: undefined };
  'run.dismiss': { params: { runId: string }; result: undefined };

  'rule.approve': { params: { ruleId: string }; result: undefined };
  'rule.setAuto': { params: { ruleId: string; enabled: boolean }; result: undefined };

  /** 抓取当前标签页并上报，返回元素数量 */
  'capture.page': { params: { tabId: number }; result: { count: number } };

  'recording.start': { params: { tabId: number }; result: undefined };
  'recording.stop': { params: undefined; result: undefined };
  'recording.setSteps': { params: { steps: Step[] }; result: undefined };
  'recording.submit': { params: undefined; result: undefined };
  'recording.discard': { params: undefined; result: undefined };
}

export type RpcMethod = keyof RpcMethods;

export type RpcResponse<T> = { ok: true; result: T } | { ok: false; error: string };

export interface RpcRequest<M extends RpcMethod = RpcMethod> {
  type: 'rpc';
  method: M;
  params: RpcMethods[M]['params'];
}

export async function rpc<M extends RpcMethod>(
  method: M,
  ...params: RpcMethods[M]['params'] extends undefined ? [] : [RpcMethods[M]['params']]
): Promise<RpcMethods[M]['result']> {
  const res = (await browser.runtime.sendMessage({
    type: 'rpc',
    method,
    params: params[0],
  })) as RpcResponse<RpcMethods[M]['result']> | undefined;
  if (!res) throw new Error('后台未响应');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

export const STATE_CHANGED = 'state.changed';

/** 订阅后台状态变化，返回取消订阅函数 */
export function onStateChanged(cb: () => void): () => void {
  const listener = (msg: unknown) => {
    if ((msg as { type?: string } | null)?.type === STATE_CHANGED) cb();
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
