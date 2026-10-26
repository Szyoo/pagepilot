import { browser } from 'wxt/browser';
import { Runner } from '../core/player';
import { command, ensureContent } from '../core/player/tabs';
import {
  applyDownlink,
  approveRule,
  autoEnabledIds,
  clearUser,
  getRule,
  isApproved,
  lastSeq,
  listRules,
  matchRules,
  setAutoEnabled,
} from '../core/rules';
import { exportVault, importVault, loadVault, profileValueIndex, saveVault } from '../core/vault';
import type { CaptureResult, ContentEvent } from '../shared/content-api';
import { EVENT_MESSAGE } from '../shared/content-api';
import {
  type BgState,
  type RpcMethod,
  type RpcMethods,
  type RpcRequest,
  type RpcResponse,
  type RuleView,
  STATE_CHANGED,
} from '../shared/rpc';
import { loadSettings, SETTINGS_KEY } from '../shared/settings';
import { uuid } from '../shared/storage';
import { POLL_ALARM, Transport, type TransportStatus } from '../transport';
import { currentUserId, login, logout, requiredOrigins } from '../transport/auth';
import { notify } from './notify';
import { hostPermitted, syncContentScripts } from './permissions';
import { RecordingSession } from './recording';

const AUTO_COOLDOWN_MS = 5 * 60_000;

export function startApp(): void {
  let connection: TransportStatus = { status: 'idle' };
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  const lastAuto = new Map<string, number>();

  const changed = () => {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      void browser.runtime.sendMessage({ type: STATE_CHANGED }).catch(() => undefined);
    }, 100);
  };

  const transport = new Transport({
    async apply(msg) {
      const uid = await currentUserId();
      if (!uid) return { type: 'ignored' };
      const result = await applyDownlink(uid, msg);
      if (result.type === 'applied') {
        const removed = new Set(result.removedRuleIds);
        if (removed.size) runner.abortWhere((r) => removed.has(r.ruleId));
        changed();
      }
      return result;
    },
    async lastSeq() {
      const uid = await currentUserId();
      return uid ? lastSeq(uid) : 0;
    },
    onStatus(status) {
      connection = status;
      changed();
    },
  });

  const runner = new Runner({
    async getRule(ruleId) {
      const uid = await currentUserId();
      return uid ? getRule(uid, ruleId) : undefined;
    },
    report: (body) => transport.send(body),
    notify,
    changed,
    hostPermitted,
    async loadVault() {
      return loadVault(await requireUser());
    },
  });

  const recording = new RecordingSession({
    changed,
    isHandoff: (tabId) => runner.views().some((r) => r.tabId === tabId && r.status === 'handoff'),
  });

  // ---- 状态 ----

  async function getState(): Promise<BgState> {
    const uid = await currentUserId();
    const rules: RuleView[] = [];
    if (uid) {
      const auto = new Set(await autoEnabledIds(uid));
      for (const r of await listRules(uid)) {
        rules.push({
          id: r.id,
          name: r.name,
          version: r.version,
          enabled: r.enabled,
          trigger: r.trigger,
          inputMode: r.inputMode,
          matchUrls: r.match.urls,
          requires: r.requires,
          stepCount: r.steps.length,
          approved: await isApproved(uid, r),
          autoEnabled: auto.has(r.id),
        });
      }
    }
    return {
      auth: uid ? { status: 'signedIn', userId: uid } : { status: 'signedOut' },
      connection:
        connection.status === 'connected'
          ? { status: 'connected', channel: connection.channel }
          : connection.status === 'error'
            ? { status: 'error', error: connection.error }
            : { status: connection.status },
      rules,
      runs: runner.views(),
      recording: recording.view(),
    };
  }

  // ---- RPC ----

  async function requireUser(): Promise<string> {
    const uid = await currentUserId();
    if (!uid) throw new Error('请先登录');
    return uid;
  }

  async function startRule(ruleId: string, tabId: number, trigger: 'manual' | 'auto') {
    const uid = await requireUser();
    const rule = await getRule(uid, ruleId);
    if (!rule?.enabled) throw new Error('规则不存在或已停用');
    if (!(await isApproved(uid, rule))) throw new Error('请先确认该规则');
    return runner.start(rule, tabId, trigger);
  }

  type Handlers = {
    [M in RpcMethod]: (params: RpcMethods[M]['params']) => Promise<RpcMethods[M]['result']>;
  };

  const handlers: Handlers = {
    'state.get': getState,
    async 'auth.login'({ username, password }) {
      await login(username, password);
      transport.restart();
      changed();
      return undefined;
    },
    'auth.origins': requiredOrigins,
    async 'connection.retry'() {
      await requireUser();
      transport.restart();
      return undefined;
    },
    async 'auth.logout'() {
      const uid = await currentUserId();
      transport.stop();
      runner.abortWhere(() => true);
      await logout();
      if (uid) await clearUser(uid);
      changed();
      return undefined;
    },

    async 'vault.get'() {
      return loadVault(await requireUser());
    },
    async 'vault.save'(data) {
      await saveVault(await requireUser(), data);
      return undefined;
    },
    async 'vault.export'() {
      return exportVault(await requireUser());
    },
    async 'vault.import'({ backup }) {
      await importVault(await requireUser(), backup);
      return undefined;
    },

    async 'run.start'({ ruleId, tabId }) {
      return { runId: await startRule(ruleId, tabId, 'manual') };
    },
    async 'run.abort'({ runId }) {
      runner.abort(runId);
      return undefined;
    },
    async 'run.confirm'({ runId }) {
      runner.confirm(runId);
      return undefined;
    },
    async 'run.dismiss'({ runId }) {
      await runner.dismiss(runId);
      return undefined;
    },

    async 'rule.approve'({ ruleId }) {
      const uid = await requireUser();
      const rule = await getRule(uid, ruleId);
      if (!rule) throw new Error('规则不存在');
      await approveRule(uid, rule);
      changed();
      return undefined;
    },
    async 'rule.setAuto'({ ruleId, enabled }) {
      const uid = await requireUser();
      const rule = await getRule(uid, ruleId);
      if (!rule) throw new Error('规则不存在');
      if (enabled && !(await isApproved(uid, rule))) throw new Error('请先确认该规则');
      await setAutoEnabled(uid, ruleId, enabled);
      changed();
      return undefined;
    },

    async 'capture.page'({ tabId }) {
      await requireUser();
      const tab = await browser.tabs.get(tabId);
      await ensureContent(tabId);
      const res = await command<CaptureResult>(tabId, { cmd: 'capture' });
      let pageUrl = tab.url ?? '';
      try {
        const u = new URL(pageUrl);
        pageUrl = `${u.origin}${u.pathname}`; // 查询串与锚点里可能带令牌
      } catch {
        // 保持原样
      }
      await transport.send({
        kind: 'capture',
        pageUrl,
        title: res.title,
        capturedAt: Date.now(),
        elements: res.elements,
      });
      return { count: res.elements.length };
    },

    async 'recording.start'({ tabId }) {
      const uid = await requireUser();
      await ensureContent(tabId);
      await recording.start(tabId, profileValueIndex(await loadVault(uid)));
      return undefined;
    },
    async 'recording.stop'() {
      await recording.stop();
      return undefined;
    },
    async 'recording.setSteps'({ steps }) {
      recording.setSteps(steps);
      return undefined;
    },
    async 'recording.submit'() {
      await requireUser();
      const { steps, startedAt } = recording.takeSteps();
      await transport.send({ kind: 'recording', recordingId: uuid(), startedAt, steps });
      return undefined;
    },
    async 'recording.discard'() {
      recording.discard();
      return undefined;
    },
  };

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const m = msg as { type?: string } | null;
    if (m?.type === 'rpc') {
      const req = msg as RpcRequest;
      const handler = handlers[req.method] as ((p: unknown) => Promise<unknown>) | undefined;
      if (!handler) {
        sendResponse({ ok: false, error: `未知方法：${req.method}` } satisfies RpcResponse<never>);
        return undefined;
      }
      handler(req.params).then(
        (result) => sendResponse({ ok: true, result } satisfies RpcResponse<unknown>),
        (e: unknown) =>
          sendResponse({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          } satisfies RpcResponse<never>),
      );
      return true;
    }
    if (m?.type === EVENT_MESSAGE) {
      const ev = msg as ContentEvent;
      const tabId = sender.tab?.id;
      if (tabId === undefined) return undefined;
      if (ev.event === 'recorded') recording.onRecorded(tabId, ev.record);
      else if (ev.event === 'loaded') void recording.onContentLoaded(tabId, sender.frameId ?? 0);
    }
    return undefined;
  });

  // ---- 自动触发 ----

  browser.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== 'complete' || !tab.url) return;
    void maybeAutoRun(tabId, tab.url);
  });

  async function maybeAutoRun(tabId: number, url: string): Promise<void> {
    const uid = await currentUserId();
    if (!uid || runner.hasActiveRun(tabId) || recording.isRecordingTab(tabId)) return;
    const auto = new Set(await autoEnabledIds(uid));
    for (const rule of matchRules(await listRules(uid), url)) {
      if (rule.trigger !== 'auto' || !auto.has(rule.id) || !(await isApproved(uid, rule))) continue;
      const key = `${rule.id}:${tabId}`;
      if (Date.now() - (lastAuto.get(key) ?? 0) < AUTO_COOLDOWN_MS) continue;
      lastAuto.set(key, Date.now());
      try {
        await runner.start(rule, tabId, 'auto');
      } catch (e) {
        notify(rule.name, `自动运行失败：${e instanceof Error ? e.message : String(e)}`, false);
      }
      return;
    }
  }

  // ---- 其他事件 ----

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === POLL_ALARM) transport.start();
  });
  browser.permissions.onAdded.addListener(() => void syncContentScripts());
  browser.permissions.onRemoved.addListener(() => void syncContentScripts());
  browser.runtime.onInstalled.addListener(() => void syncContentScripts());
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      void currentUserId().then((uid) => {
        if (uid) transport.restart();
      });
      changed();
    }
  });

  // ---- 启动 ----

  void (async () => {
    await runner.init();
    await syncContentScripts().catch(() => undefined);
    const settings = await loadSettings();
    if ((await currentUserId()) && settings.backendUrl) transport.start();
    changed();
  })();
}
