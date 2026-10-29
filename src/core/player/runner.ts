import { browser } from 'wxt/browser';
import type { ErrorCode, StepReport, UplinkBody } from '../../schema/message';
import type { LocalData } from '../../schema/profile';
import { type Condition, flattenSteps, type Rule, type Step } from '../../schema/rule';
import type { ActResult, PrepareResult } from '../../shared/content-api';
import { hostnameOf, matchesGlob, samePage } from '../../shared/glob';
import { describeError, stepLabel } from '../../shared/labels';
import type { ResolveAction, RunView, StuckView } from '../../shared/rpc';
import { loadSettings, type Settings } from '../../shared/settings';
import { getItem, setItem, sleep, uuid } from '../../shared/storage';
import { renderTemplate } from '../../shared/template';
import { missingData, resolvePlaceholder, VaultError } from '../vault';
import { TrustedInput } from './input';
import { suggestResume } from './resume';
import { command, ensureContent, type Located, locate, toTopViewport } from './tabs';

/**
 * 回放引擎：运行在 background，状态每步写入 storage.session，
 * service worker 被回收后可从游标处继续。
 */

export class RunError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** 叶子步骤重试用尽仍失败，且可以暂停交给用户处理（由所在的 execList 接住） */
class StepFailed extends RunError {
  constructor(
    readonly step: Step,
    cause: RunError,
  ) {
    super(cause.code, cause.message);
  }
}

/** 这些错误不是页面问题，重试或进入下一轮都没有意义 */
const FATAL: ErrorCode[] = [
  'USER_ABORTED',
  'DATA_MISSING',
  'SECRET_ORIGIN_DENIED',
  'PERMISSION_DENIED',
];

interface CursorEntry {
  i: number;
  attempt?: number;
  startedAt?: number;
}

export interface PersistedRun {
  runId: string;
  ruleId: string;
  ruleVersion: number;
  ruleName: string;
  trigger: 'manual' | 'auto';
  tabId: number;
  status: RunView['status'];
  startedAt: number;
  endedAt?: number;
  stepId?: string;
  /** 当前步骤的说明（取自步骤的 note），侧边栏优先显示 */
  stepNote?: string;
  message?: string;
  repeat?: { attempt: number; max: number };
  needsConfirm?: boolean;
  /** 交还会在页面条件满足 / 跳转后自动继续（同时仍可手动继续） */
  autoResume?: boolean;
  errorCode?: string;
  inputMode: 'trusted' | 'synthetic';
  phase: 'login' | 'main';
  cursor: CursorEntry[];
  vars: Record<string, string>;
  stepReports: StepReport[];
  relogins: number;
  aborted?: boolean;
  handoffConfirmed?: boolean;
  /** 步骤失败后暂停等用户处理 */
  stuck?: StuckView;
}

export interface RunnerDeps {
  getRule(ruleId: string): Promise<Rule | undefined>;
  report(body: UplinkBody): Promise<void>;
  notify(title: string, message: string, sound: boolean): void;
  changed(): void;
  hostPermitted(rule: Rule): Promise<boolean>;
  /** 当前门户用户的本地数据 */
  loadVault(): Promise<LocalData>;
}

interface Ctx {
  run: PersistedRun;
  rule: Rule;
  settings: Settings;
  vault: LocalData;
  input: TrustedInput;
  resume: (CursorEntry | undefined)[];
  /** 上一步开始的时间，用于判断「之后发生的导航 / 新标签页」 */
  prevStepAt: number;
  /** 当前叶子步骤开始的时间 */
  curStepAt: number;
  captchaMutedUntil: number;
  persistCursor: boolean;
  /** 当前所在的 repeat 嵌套深度；循环体里的失败不暂停 */
  repeatDepth: number;
  /** 正在重新登录（tryRelogin）时为正；登录步骤的失败不暂停 */
  reloginDepth: number;
}

const STORE = 'runs';
const KEEP = 20;
const POLL_MS = 250;

const PAGE_STEPS = new Set(['click', 'fill', 'select', 'check', 'press', 'extract', 'assert']);

export class Runner {
  private runs = new Map<string, PersistedRun>();
  private aborted = new Set<string>();
  private confirmed = new Set<string>();
  private resolutions = new Map<string, { action: ResolveAction; index?: number }>();
  private active = new Set<string>();
  private navStart = new Map<number, number>();
  private newTabs: { id: number; at: number }[] = [];

  constructor(private deps: RunnerDeps) {
    // MV3：事件监听必须在 service worker 启动时同步注册
    browser.tabs.onUpdated.addListener((tabId, info) => {
      if (info.status === 'loading') this.navStart.set(tabId, Date.now());
    });
    browser.tabs.onCreated.addListener((tab) => {
      if (tab.id !== undefined) this.newTabs.push({ id: tab.id, at: Date.now() });
      this.newTabs = this.newTabs.slice(-20);
    });
    browser.tabs.onRemoved.addListener((tabId) => {
      this.navStart.delete(tabId);
      for (const run of this.runs.values()) {
        if (run.tabId === tabId && (run.status === 'running' || run.status === 'handoff')) {
          this.aborted.add(run.runId);
        }
      }
    });
  }

  /** 载入持久化的运行记录，并继续 service worker 回收前未完成的运行 */
  async init(): Promise<void> {
    const stored = await getItem<Record<string, PersistedRun>>('session', STORE, {});
    for (const run of Object.values(stored)) this.runs.set(run.runId, run);
    for (const run of this.runs.values()) {
      if (run.status === 'running' || run.status === 'handoff') void this.resume(run);
    }
  }

  views(): RunView[] {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => ({
        runId: r.runId,
        ruleId: r.ruleId,
        ruleName: r.ruleName,
        tabId: r.tabId,
        status: r.status,
        startedAt: r.startedAt,
        ...(r.endedAt ? { endedAt: r.endedAt } : {}),
        ...(r.stepId ? { stepId: r.stepId } : {}),
        ...(r.stepNote ? { stepNote: r.stepNote } : {}),
        ...(r.message ? { message: r.message } : {}),
        ...(r.repeat ? { repeat: r.repeat } : {}),
        ...(r.needsConfirm !== undefined ? { needsConfirm: r.needsConfirm } : {}),
        ...(r.autoResume ? { autoResume: true } : {}),
        ...(r.errorCode ? { errorCode: r.errorCode } : {}),
        ...(r.stuck ? { stuck: r.stuck } : {}),
      }));
  }

  hasActiveRun(tabId: number): boolean {
    return [...this.runs.values()].some(
      (r) => r.tabId === tabId && (r.status === 'running' || r.status === 'handoff'),
    );
  }

  hasActiveRuns(): boolean {
    return [...this.runs.values()].some((r) => r.status === 'running' || r.status === 'handoff');
  }

  /** 中止指定规则的运行（规则被删除或用户登出时） */
  abortWhere(pred: (run: PersistedRun) => boolean): void {
    for (const run of this.runs.values()) {
      if ((run.status === 'running' || run.status === 'handoff') && pred(run)) {
        this.aborted.add(run.runId);
      }
    }
  }

  abort(runId: string): void {
    this.aborted.add(runId);
  }

  /** 交还后的「继续」；对步骤失败暂停的运行等价于 resolve(continue) */
  confirm(runId: string): void {
    this.confirmed.add(runId);
  }

  /** 步骤失败暂停后用户的选择 */
  resolve(runId: string, action: ResolveAction, index?: number): void {
    const run = this.runs.get(runId);
    if (!run?.stuck || run.status !== 'handoff') throw new Error('该运行没有在等待处理失败的步骤');
    if (action === 'goto') {
      if (
        index === undefined ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > run.stuck.steps.length
      ) {
        throw new Error('要继续的步骤超出范围');
      }
      this.resolutions.set(runId, { action, index });
      return;
    }
    this.resolutions.set(runId, { action });
  }

  async dismiss(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.status === 'running' || run.status === 'handoff') return;
    this.runs.delete(runId);
    await this.save();
    this.deps.changed();
  }

  async start(rule: Rule, tabId: number, trigger: 'manual' | 'auto'): Promise<string> {
    if (this.hasActiveRun(tabId)) throw new Error('该标签页已有规则在运行');
    if (!(await this.deps.hostPermitted(rule))) throw new Error('缺少该规则涉及网站的访问权限');
    const vault = await this.deps.loadVault();
    const missing = missingData(vault, rule.requires);
    if (missing.length) throw new Error(`缺少本地数据：${missing.join('、')}`);

    const settings = await loadSettings();
    const tab = await browser.tabs.get(tabId);
    const mode = await this.effectiveMode(rule, settings, tab.url ?? '');

    const run: PersistedRun = {
      runId: uuid(),
      ruleId: rule.id,
      ruleVersion: rule.version,
      ruleName: rule.name,
      trigger,
      tabId,
      status: 'running',
      startedAt: Date.now(),
      inputMode: mode,
      phase: 'main',
      cursor: [],
      vars: {},
      stepReports: [],
      relogins: 0,
    };
    this.runs.set(run.runId, run);
    await this.save();
    this.deps.changed();
    void this.execute(this.makeCtx(run, rule, settings, vault, []), true);
    return run.runId;
  }

  private async resume(run: PersistedRun): Promise<void> {
    const rule = await this.deps.getRule(run.ruleId);
    if (!rule) {
      run.status = 'failed';
      run.errorCode = 'INTERNAL';
      run.endedAt = Date.now();
      await this.save();
      this.deps.changed();
      return;
    }
    if (run.stuck) {
      // 卡住期间 service worker 被回收：重新执行失败的那一步（失败则再次卡住），去掉上次的失败报告
      const last = run.stepReports.at(-1);
      if (last?.stepId === run.stuck.failedStepId && last.status === 'failed')
        run.stepReports.pop();
      delete run.stuck;
      delete run.message;
      delete run.needsConfirm;
      run.status = 'running';
    }
    const settings = await loadSettings();
    void this.execute(
      this.makeCtx(run, rule, settings, await this.deps.loadVault(), [...run.cursor]),
      false,
    );
  }

  private makeCtx(
    run: PersistedRun,
    rule: Rule,
    settings: Settings,
    vault: LocalData,
    resume: CursorEntry[],
  ): Ctx {
    return {
      run,
      rule,
      settings,
      vault,
      input: new TrustedInput(),
      resume,
      prevStepAt: Date.now(),
      curStepAt: Date.now(),
      captchaMutedUntil: 0,
      persistCursor: true,
      repeatDepth: 0,
      reloginDepth: 0,
    };
  }

  private async effectiveMode(rule: Rule, settings: Settings, url: string) {
    const site = settings.sites[hostnameOf(url)]?.inputMode;
    const wanted = site && site !== 'auto' ? site : rule.inputMode;
    const hasDebugger = await browser.permissions.contains({ permissions: ['debugger'] });
    if (wanted === 'trusted') {
      if (!hasDebugger) throw new Error('该规则需要「调试」权限才能发送真实输入');
      return 'trusted' as const;
    }
    if (wanted === 'synthetic') return 'synthetic' as const;
    return hasDebugger ? ('trusted' as const) : ('synthetic' as const);
  }

  // ---- 持久化 ----

  private async save(): Promise<void> {
    const all = [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
    const finished = all.filter((r) => r.status !== 'running' && r.status !== 'handoff');
    for (const r of finished.slice(KEEP)) this.runs.delete(r.runId);
    await setItem('session', STORE, Object.fromEntries(this.runs));
  }

  private async persist(_ctx: Ctx): Promise<void> {
    await this.save();
    this.deps.changed();
  }

  // ---- 执行 ----

  private async execute(ctx: Ctx, fresh: boolean): Promise<void> {
    const { run, rule } = ctx;
    if (this.active.has(run.runId)) return;
    this.active.add(run.runId);
    let final = false;
    try {
      await ensureContent(run.tabId);
      if (fresh && rule.login && !(await this.evalCondition(ctx, rule.login.loggedIn))) {
        run.phase = 'login';
      }
      if (run.phase === 'login' && rule.login) {
        await this.execList(ctx, rule.login.steps, 0);
        run.phase = 'main';
        run.cursor = [];
        ctx.resume = [];
      }
      final = (await this.execList(ctx, rule.steps, 0)) === 'final';
      run.status = final ? 'handedOff' : 'succeeded';
    } catch (e) {
      if (e instanceof RunError) {
        run.errorCode = e.code;
        run.status = e.code === 'USER_ABORTED' ? 'aborted' : 'failed';
      } else {
        run.errorCode = 'INTERNAL';
        run.status = 'failed';
        console.warn('[pagepilot] 运行异常', e instanceof Error ? e.message : e);
      }
    } finally {
      run.endedAt = Date.now();
      delete run.message;
      delete run.repeat;
      delete run.needsConfirm;
      delete run.stuck;
      await ctx.input.detachAll();
      this.active.delete(run.runId);
      this.aborted.delete(run.runId);
      this.confirmed.delete(run.runId);
      this.resolutions.delete(run.runId);
      await this.save();
      this.deps.changed();
      await this.sendReport(ctx).catch(() => undefined);
    }
  }

  private async sendReport(ctx: Ctx): Promise<void> {
    const { run } = ctx;
    const status = run.status === 'running' || run.status === 'handoff' ? 'failed' : run.status;
    await this.deps.report({
      kind: 'runReport',
      runId: run.runId,
      ruleId: run.ruleId,
      ruleVersion: run.ruleVersion,
      trigger: run.trigger,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? Date.now(),
      status,
      inputMode: run.inputMode,
      steps: run.stepReports,
    });
  }

  private checkAbort(ctx: Ctx): void {
    if (this.aborted.has(ctx.run.runId) || ctx.run.aborted) throw new RunError('USER_ABORTED');
  }

  /** 可中止的等待 */
  private async wait(ctx: Ctx, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      this.checkAbort(ctx);
      await sleep(Math.min(POLL_MS, end - Date.now()));
    }
    this.checkAbort(ctx);
  }

  private async poll<T>(
    ctx: Ctx,
    fn: () => Promise<T | undefined | false>,
    timeoutMs: number,
    code: ErrorCode,
  ): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      this.checkAbort(ctx);
      try {
        const v = await fn();
        if (v) return v;
      } catch (e) {
        if (e instanceof RunError) throw e;
      }
      if (Date.now() >= end) throw new RunError(code);
      await sleep(POLL_MS);
    }
  }

  private async execList(ctx: Ctx, steps: Step[], level: number): Promise<'done' | 'final'> {
    let resumed = ctx.resume[level];
    ctx.resume[level] = undefined;
    let i = resumed?.i ?? 0;
    while (i < steps.length) {
      const step = steps[i];
      if (!step) {
        i++;
        continue;
      }
      if (ctx.persistCursor) {
        ctx.run.cursor.length = level;
        ctx.run.cursor[level] = { i };
        await this.persist(ctx);
      }
      // 恢复的游标（如 repeat 的轮次）只用于第一次执行的那一步，跳回同一步时不再沿用
      const entry = resumed && i === resumed.i ? resumed : undefined;
      resumed = undefined;
      let result: 'ok' | 'final';
      try {
        result = await this.execStep(ctx, step, level, i, entry);
      } catch (e) {
        if (!(e instanceof StepFailed) || e.step !== step) throw e;
        i = await this.stuck(ctx, steps, i, e);
        continue;
      }
      if (result === 'final') return 'final';
      i++;
    }
    return 'done';
  }

  private async execStep(
    ctx: Ctx,
    step: Step,
    level: number,
    index: number,
    resumeEntry: CursorEntry | undefined,
  ): Promise<'ok' | 'final'> {
    this.checkAbort(ctx);
    ctx.run.stepId = step.id;
    const note = step.note?.trim();
    if (note) ctx.run.stepNote = note;
    else delete ctx.run.stepNote;
    delete ctx.run.repeat;

    if (step.type === 'if') {
      const yes = await this.evalCondition(ctx, step.condition);
      const branch = yes ? step.then : step.else;
      if (!branch) return 'ok';
      return (await this.execList(ctx, branch, level + 1)) === 'final' ? 'final' : 'ok';
    }
    if (step.type === 'repeat') return this.execRepeat(ctx, step, level, index, resumeEntry);
    if (step.type === 'handoff') return this.execHandoff(ctx, step);

    if (PAGE_STEPS.has(step.type)) await this.guardCaptcha(ctx);

    const started = Date.now();
    let attempts = 0;
    let lastError: RunError = new RunError('INTERNAL');
    const maxAttempts = step.retries + 1;
    while (attempts < maxAttempts) {
      attempts++;
      if (attempts === 1) {
        // 等待导航 / 新标签页从上一步开始时算起：上一步（如点击）触发的跳转可能在本步开始前就已发生
        ctx.prevStepAt = ctx.curStepAt;
        ctx.curStepAt = started;
      }
      try {
        await this.runLeaf(ctx, step);
        ctx.run.stepReports.push({
          stepId: step.id,
          status: 'succeeded',
          attempts,
          durationMs: Date.now() - started,
        });
        return 'ok';
      } catch (e) {
        lastError =
          e instanceof RunError
            ? e
            : e instanceof VaultError
              ? new RunError(e.code, e.message)
              : new RunError('INTERNAL', e instanceof Error ? e.message : String(e));
        if (FATAL.includes(lastError.code)) break;
        if (await this.tryRelogin(ctx, level)) {
          attempts--; // 重新登录不消耗重试次数
          continue;
        }
        await this.wait(ctx, 500);
      }
    }

    const failed: StepReport = {
      stepId: step.id,
      status: step.optional && !FATAL.includes(lastError.code) ? 'skipped' : 'failed',
      attempts,
      durationMs: Date.now() - started,
      errorCode: lastError.code,
    };
    ctx.run.stepReports.push(failed);
    if (failed.status === 'skipped') return 'ok';
    // 循环体里某轮失败会进入下一轮；重新登录时登录步骤失败按原样处理；其余暂停交给用户
    if (lastError.code !== 'USER_ABORTED' && ctx.repeatDepth === 0 && ctx.reloginDepth === 0) {
      throw new StepFailed(step, lastError);
    }
    throw lastError;
  }

  /** 登录失效时重新执行登录流程；同一次运行最多 2 次 */
  private async tryRelogin(ctx: Ctx, level: number): Promise<boolean> {
    const { rule, run } = ctx;
    if (!rule.login || run.relogins >= 2 || run.phase === 'login') return false;
    try {
      if (await this.evalCondition(ctx, rule.login.loggedIn)) return false;
    } catch {
      return false;
    }
    run.relogins++;
    const savedPersist = ctx.persistCursor;
    const savedCursor = run.cursor.map((c) => ({ ...c }));
    ctx.persistCursor = false;
    ctx.reloginDepth++;
    run.phase = 'login';
    try {
      await this.execList(ctx, rule.login.steps, level + 8);
    } finally {
      ctx.reloginDepth--;
      run.phase = 'main';
      ctx.persistCursor = savedPersist;
      run.cursor = savedCursor;
    }
    return true;
  }

  // ---- 条件、定位、模板 ----

  private async evalCondition(ctx: Ctx, c: Condition): Promise<boolean> {
    const res = await command<{ result: boolean }>(ctx.run.tabId, {
      cmd: 'condition',
      condition: c,
    });
    return res.result;
  }

  private async locateOrFail(ctx: Ctx, locator: Parameters<typeof locate>[1], timeoutMs: number) {
    return this.poll<Located>(
      ctx,
      async () => (await locate(ctx.run.tabId, locator)) ?? undefined,
      timeoutMs,
      'TARGET_NOT_FOUND',
    );
  }

  private render(ctx: Ctx, text: string, host: string): string {
    return renderTemplate(text, (scope, key) => {
      if (scope === 'var') {
        const v = ctx.run.vars[key];
        if (v === undefined) throw new RunError('DATA_MISSING', `变量未定义：${key}`);
        return v;
      }
      return resolvePlaceholder(ctx.vault, scope, key, host);
    });
  }

  private async guardCaptcha(ctx: Ctx): Promise<void> {
    // 规则里已经写了交还步骤：作者安排好了在哪一步亲自处理验证码，不再自动检测、提前暂停
    if (usesManualHandoff(ctx.rule)) return;
    if (Date.now() < ctx.captchaMutedUntil) return;
    const found = async () =>
      (
        await command<{ found: boolean }>(ctx.run.tabId, { cmd: 'captcha' }).catch(() => ({
          found: false,
        }))
      ).found;
    if (!(await found())) return;
    await this.handoffWait(ctx, {
      message: '检测到人机验证，请完成后继续',
      needsConfirm: true,
      resumed: async () => !(await found()),
    });
    ctx.captchaMutedUntil = Date.now() + 30_000;
  }

  // ---- 叶子步骤 ----

  private async runLeaf(ctx: Ctx, step: Exclude<Step, { type: 'if' | 'repeat' | 'handoff' }>) {
    const tabId = ctx.run.tabId;
    const trusted = ctx.run.inputMode === 'trusted';

    switch (step.type) {
      case 'open': {
        const url = this.render(ctx, step.url, '');
        // 已经停在同一页面（网站与路径相同、已加载完）就不再重新打开，直接进入下一步
        if (!step.newTab && !step.force && (await this.alreadyOn(tabId, url))) {
          await this.ensureOrFail(tabId);
          return;
        }
        const since = Date.now();
        if (step.newTab) {
          const tab = await browser.tabs.create({ url, active: true });
          if (tab.id === undefined) throw new RunError('NAVIGATION_FAILED');
          ctx.run.tabId = tab.id;
        } else {
          await browser.tabs.update(tabId, { url });
        }
        await this.waitLoaded(ctx, ctx.run.tabId, since, step.timeoutMs);
        await this.ensureOrFail(ctx.run.tabId);
        return;
      }
      case 'click': {
        const loc = await this.locateOrFail(ctx, step.target, step.timeoutMs);
        if (trusted) await this.trustedClick(ctx, loc, step.target);
        else await this.act(ctx, loc, step.target, { action: 'click' });
        return;
      }
      case 'fill': {
        const loc = await this.locateOrFail(ctx, step.target, step.timeoutMs);
        const value = this.render(ctx, step.value, hostnameOf(loc.url));
        if (trusted) {
          await this.prepare(ctx, loc, step.target, true, step.clear);
          if (step.clear && value === '') await ctx.input.key(tabId, 'Backspace');
          else await ctx.input.insertText(tabId, value);
        } else {
          await this.act(ctx, loc, step.target, { action: 'fill', value, clear: step.clear });
        }
        return;
      }
      case 'select': {
        const loc = await this.locateOrFail(ctx, step.target, step.timeoutMs);
        const value = this.render(ctx, step.value, hostnameOf(loc.url));
        await this.act(ctx, loc, step.target, { action: 'select', value });
        return;
      }
      case 'check': {
        const loc = await this.locateOrFail(ctx, step.target, step.timeoutMs);
        if (trusted) {
          const p = await this.prepare(ctx, loc, step.target, false, false);
          if (p.checked !== step.checked) {
            const pt = await toTopViewport(tabId, loc.frameId, p);
            await ctx.input.click(tabId, pt.x, pt.y);
          }
        } else {
          await this.act(ctx, loc, step.target, { action: 'check', checked: step.checked });
        }
        return;
      }
      case 'press': {
        if (step.target) {
          const loc = await this.locateOrFail(ctx, step.target, step.timeoutMs);
          if (trusted) {
            await this.prepare(ctx, loc, step.target, true, false);
            await ctx.input.key(tabId, step.key);
          } else await this.act(ctx, loc, step.target, { action: 'press', key: step.key });
        } else if (trusted) {
          await ctx.input.key(tabId, step.key);
        } else {
          await command(tabId, { cmd: 'act', act: { action: 'press', key: step.key } });
        }
        return;
      }
      case 'waitFor':
        return this.waitFor(ctx, step);
      case 'switchTab': {
        const tab = await this.poll(
          ctx,
          async () => {
            const tabs = await browser.tabs.query({});
            return tabs
              .filter((t) => t.url && matchesGlob(step.urlPattern, t.url))
              .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
          },
          step.timeoutMs,
          'NAVIGATION_FAILED',
        );
        if (tab.id === undefined) throw new RunError('NAVIGATION_FAILED');
        await browser.tabs.update(tab.id, { active: true });
        ctx.run.tabId = tab.id;
        await this.ensureOrFail(tab.id);
        return;
      }
      case 'assert':
        await this.poll(
          ctx,
          () => this.evalCondition(ctx, step.condition),
          step.timeoutMs,
          'ASSERT_FAILED',
        );
        return;
      case 'extract': {
        const loc = await this.locateOrFail(ctx, step.target, step.timeoutMs);
        const res = await command<ActResult>(
          tabId,
          {
            cmd: 'act',
            act: { action: 'extract', attr: step.attr },
            locator: step.target,
            ignoreFrame: loc.ignoreFrame,
          },
          loc.frameId,
        );
        if (!res.ok) throw new RunError(res.code);
        ctx.run.vars[step.saveAs] = (res.value ?? '').slice(0, 2000);
        return;
      }
    }
  }

  /** 标签页是否已停在目标页面：比较网站与路径（忽略查询参数、锚点与末尾斜杠），且已加载完 */
  private async alreadyOn(tabId: number, target: string): Promise<boolean> {
    const tab = await browser.tabs.get(tabId).catch(() => undefined);
    if (!tab?.url || tab.status !== 'complete') return false;
    return samePage(tab.url, target);
  }

  private async ensureOrFail(tabId: number): Promise<void> {
    try {
      await ensureContent(tabId);
    } catch {
      throw new RunError('PERMISSION_DENIED', '无法在该页面运行（缺少网站访问权限？）');
    }
  }

  private async act(
    ctx: Ctx,
    loc: Located,
    locator: Parameters<typeof locate>[1],
    act: Parameters<typeof command>[1] extends infer C
      ? C extends { act: infer A }
        ? A
        : never
      : never,
  ): Promise<void> {
    const res = await command<ActResult>(
      ctx.run.tabId,
      { cmd: 'act', act, locator, ignoreFrame: loc.ignoreFrame },
      loc.frameId,
    );
    if (!res.ok) throw new RunError(res.code, res.message);
  }

  private async prepare(
    ctx: Ctx,
    loc: Located,
    locator: Parameters<typeof locate>[1],
    focus: boolean,
    selectContent: boolean,
  ): Promise<{ x: number; y: number; checked?: boolean }> {
    const res = await command<PrepareResult>(
      ctx.run.tabId,
      { cmd: 'prepare', locator, ignoreFrame: loc.ignoreFrame, focus, selectContent },
      loc.frameId,
    );
    if (!res.ok) throw new RunError(res.code);
    return res;
  }

  private async trustedClick(ctx: Ctx, loc: Located, locator: Parameters<typeof locate>[1]) {
    const p = await this.prepare(ctx, loc, locator, false, false);
    const pt = await toTopViewport(ctx.run.tabId, loc.frameId, p);
    await ctx.input.click(ctx.run.tabId, pt.x, pt.y);
  }

  // ---- 等待 ----

  private async waitLoaded(ctx: Ctx, tabId: number, since: number, timeoutMs: number) {
    await this.poll(
      ctx,
      async () => {
        const started = this.navStart.get(tabId);
        if ((started === undefined || started < since) && Date.now() - since < 1500) return false;
        const tab = await browser.tabs.get(tabId);
        return tab.status === 'complete';
      },
      Math.max(timeoutMs, 5000),
      'NAVIGATION_FAILED',
    );
  }

  private async waitFor(ctx: Ctx, step: Extract<Step, { type: 'waitFor' }>) {
    const tabId = ctx.run.tabId;
    switch (step.until) {
      case 'delay':
        await this.wait(ctx, step.delayMs ?? 0);
        return;
      case 'idle':
        await this.poll(
          ctx,
          async () => (await command<{ idle: boolean }>(tabId, { cmd: 'idle' })).idle,
          step.timeoutMs,
          'TIMEOUT',
        );
        return;
      case 'condition':
        if (!step.condition) throw new RunError('INTERNAL');
        await this.poll(
          ctx,
          () => this.evalCondition(ctx, step.condition as Condition),
          step.timeoutMs,
          'TIMEOUT',
        );
        return;
      case 'navigation': {
        const since = ctx.prevStepAt;
        await this.poll(
          ctx,
          async () => {
            const started = this.navStart.get(tabId);
            if (started === undefined || started < since) return false;
            const tab = await browser.tabs.get(tabId);
            if (tab.status !== 'complete') return false;
            return !step.urlPattern || (tab.url ? matchesGlob(step.urlPattern, tab.url) : false);
          },
          step.timeoutMs,
          'NAVIGATION_FAILED',
        );
        await ensureContent(tabId);
        return;
      }
      case 'newTab': {
        const since = ctx.prevStepAt;
        await this.poll(
          ctx,
          async () => {
            for (const t of this.newTabs.filter((n) => n.at >= since)) {
              const tab = await browser.tabs.get(t.id).catch(() => undefined);
              const url = tab?.url || tab?.pendingUrl || '';
              if (tab && (!step.urlPattern || matchesGlob(step.urlPattern, url))) return true;
            }
            return false;
          },
          step.timeoutMs,
          'NAVIGATION_FAILED',
        );
        return;
      }
    }
  }

  // ---- 交还与循环 ----

  private async handoffWait(
    ctx: Ctx,
    opts: {
      message: string;
      needsConfirm: boolean;
      autoResume?: boolean;
      resumed: () => Promise<boolean>;
    },
  ): Promise<void> {
    const { run } = ctx;
    run.status = 'handoff';
    run.message = opts.message;
    run.needsConfirm = opts.needsConfirm;
    if (opts.autoResume) run.autoResume = true;
    else delete run.autoResume;
    run.handoffConfirmed = false;
    this.confirmed.delete(run.runId);
    await this.persist(ctx);
    this.deps.notify(ctx.rule.name, opts.message, false);
    try {
      for (;;) {
        this.checkAbort(ctx);
        if (this.confirmed.has(run.runId)) break;
        if (await opts.resumed().catch(() => false)) break;
        await sleep(500);
      }
    } finally {
      this.confirmed.delete(run.runId);
      run.status = 'running';
      delete run.message;
      delete run.needsConfirm;
      delete run.autoResume;
      await this.persist(ctx);
    }
  }

  private async execHandoff(
    ctx: Ctx,
    step: Extract<Step, { type: 'handoff' }>,
  ): Promise<'ok' | 'final'> {
    const started = Date.now();
    if (step.final) {
      ctx.run.message = step.message;
      ctx.run.stepReports.push({
        stepId: step.id,
        status: 'handedOff',
        attempts: 1,
        durationMs: 0,
      });
      this.deps.notify(ctx.rule.name, step.message, false);
      return 'final';
    }
    const navSince = Date.now();
    await this.handoffWait(ctx, {
      message: step.message,
      // 按页面条件 / 跳转自动继续的交还也保留「继续」按钮，条件迟迟不满足时可以手动继续
      needsConfirm: true,
      autoResume: step.resumeWhen !== 'userConfirm',
      resumed: async () => {
        if (step.resumeWhen === 'navigation') {
          const s = this.navStart.get(ctx.run.tabId);
          if (s === undefined || s < navSince) return false;
          return (await browser.tabs.get(ctx.run.tabId)).status === 'complete';
        }
        if (step.resumeWhen === 'condition' && step.until)
          return this.evalCondition(ctx, step.until);
        return false;
      },
    });
    await ensureContent(ctx.run.tabId).catch(() => undefined);
    // 用户刚处理完（如输完验证码），页面上的验证码还在，短时间内不要再自动交还一次
    ctx.captchaMutedUntil = Date.now() + 30_000;
    ctx.run.stepReports.push({
      stepId: step.id,
      status: 'succeeded',
      attempts: 1,
      durationMs: Date.now() - started,
    });
    return 'ok';
  }

  private async execRepeat(
    ctx: Ctx,
    step: Extract<Step, { type: 'repeat' }>,
    level: number,
    index: number,
    resumeEntry: CursorEntry | undefined,
  ): Promise<'ok' | 'final'> {
    const { run } = ctx;
    const startedAt = resumeEntry?.startedAt ?? Date.now();
    let attempt = resumeEntry?.attempt ?? 0;
    const interval = Math.max(step.intervalMs, ctx.settings.minRepeatIntervalMs);

    for (;;) {
      const elapsed = Date.now() - startedAt;
      if (
        attempt >= step.maxAttempts ||
        (step.maxDurationMs !== undefined && elapsed > step.maxDurationMs)
      ) {
        break;
      }
      attempt++;
      if (ctx.persistCursor) run.cursor[level] = { i: index, attempt, startedAt };
      run.repeat = { attempt, max: step.maxAttempts };
      await this.persist(ctx);

      if (attempt > 1) {
        await this.wait(ctx, interval + Math.floor(Math.random() * (step.jitterMs + 1)));
        if (step.reload) {
          const since = Date.now();
          await browser.tabs.reload(run.tabId);
          await this.waitLoaded(ctx, run.tabId, since, step.timeoutMs);
          await this.ensureOrFail(run.tabId);
        }
      }

      ctx.repeatDepth++;
      try {
        if ((await this.execList(ctx, step.steps, level + 1)) === 'final') return 'final';
      } catch (e) {
        if (!(e instanceof RunError) || FATAL.includes(e.code)) throw e;
        // 本轮失败，进入下一轮
      } finally {
        ctx.repeatDepth--;
      }

      if (await this.evalCondition(ctx, step.until).catch(() => false)) {
        delete run.repeat;
        if (step.notify) {
          this.deps.notify(ctx.rule.name, '条件已满足', step.sound && ctx.settings.sound);
        }
        return 'ok';
      }
    }

    delete run.repeat;
    if (step.onExhausted === 'handoff') {
      await this.handoffWait(ctx, {
        message: '已达到最大尝试次数，条件仍未满足',
        needsConfirm: true,
        resumed: async () => false,
      });
      return 'ok';
    }
    throw new RunError('REPEAT_EXHAUSTED');
  }

  // ---- 步骤失败暂停 ----

  /**
   * 叶子步骤失败后暂停，等用户在页面上手动处理后选择从哪一步继续。
   * 返回同一层里接着执行的索引（等于 steps.length 表示这一层已完成）。
   */
  private async stuck(
    ctx: Ctx,
    steps: Step[],
    failedIndex: number,
    err: StepFailed,
  ): Promise<number> {
    const { run } = ctx;
    const step = err.step;
    const failedAt = Date.now();
    const reportIndex = run.stepReports.length - 1;
    const detail = err.message && err.message !== err.code ? `（${err.message}）` : '';
    const errorText = `${describeError(err.code)}${detail}`;
    const stuck: StuckView = {
      failedStepId: step.id,
      failedIndex,
      errorCode: err.code,
      errorText,
      suggestedIndex: failedIndex,
      steps: steps.map((s, index) => {
        const note = s.note?.trim();
        return { index, id: s.id, type: s.type, ...(note ? { note } : {}) };
      }),
    };
    const message = `第 ${failedIndex + 1} 步「${stepLabel(step)}」失败：${errorText}。你可以在页面上手动处理，然后点「继续」`;
    run.stuck = stuck;
    run.status = 'handoff';
    run.message = message;
    run.needsConfirm = true;
    delete run.autoResume;
    this.confirmed.delete(run.runId);
    this.resolutions.delete(run.runId);
    await this.persist(ctx);
    this.deps.notify(ctx.rule.name, message, false);

    const suggest = async () => {
      const tab = await browser.tabs.get(run.tabId).catch(() => undefined);
      const navigated = (this.navStart.get(run.tabId) ?? 0) >= failedAt;
      return suggestResume(steps, failedIndex, tab?.url ?? '', navigated);
    };

    let choice: { action: ResolveAction; index?: number } | undefined;
    let nextCheck = 0;
    while (!choice) {
      this.checkAbort(ctx);
      choice =
        this.resolutions.get(run.runId) ??
        (this.confirmed.has(run.runId) ? { action: 'continue' } : undefined);
      if (choice) break;
      if (Date.now() >= nextCheck) {
        nextCheck = Date.now() + 1000;
        const next = await suggest();
        if (next !== stuck.suggestedIndex) {
          stuck.suggestedIndex = next;
          await this.persist(ctx);
        }
      }
      await sleep(POLL_MS);
    }
    this.resolutions.delete(run.runId);
    this.confirmed.delete(run.runId);

    const target =
      choice.action === 'continue'
        ? stuck.suggestedIndex
        : choice.action === 'retry'
          ? failedIndex
          : choice.action === 'skip'
            ? failedIndex + 1
            : Math.min(Math.max(choice.index ?? failedIndex, 0), steps.length);

    const report = run.stepReports[reportIndex];
    if (choice.action === 'skip') {
      if (report) report.status = 'skipped';
    } else if (target > failedIndex) {
      // 失败的那一步与用户手动越过的步骤记为「用户手动处理」
      if (report) report.status = 'handedOff';
      for (let k = failedIndex + 1; k < target; k++) {
        const s = steps[k];
        if (s)
          run.stepReports.push({ stepId: s.id, status: 'handedOff', attempts: 0, durationMs: 0 });
      }
    }

    // 用户可能刚在设置页补了本地数据
    ctx.vault = await this.deps.loadVault();
    await ensureContent(run.tabId).catch(() => undefined);
    run.status = 'running';
    delete run.stuck;
    delete run.message;
    delete run.needsConfirm;
    await this.persist(ctx);
    return target;
  }
}

/** 规则（含登录步骤与嵌套步骤）里有没有交还步骤；有则不做验证码的自动检测 */
export function usesManualHandoff(rule: Pick<Rule, 'steps' | 'login'>): boolean {
  return flattenSteps(rule).some((s) => s.type === 'handoff');
}
