import { browser } from 'wxt/browser';
import { type Step, stepSchema } from '../schema/rule';
import { CONTENT_MESSAGE, type RecordedAction } from '../shared/content-api';
import type { RecordingView } from '../shared/rpc';

/** 后台聚合录制：把各 frame 上报的原始操作转成规则步骤，并脱敏 */

/** 验证码、短信验证码这类每次都不同的输入：不可能存进保险库，录成交还给用户的步骤 */
const USER_INPUT_FIELD = /captcha|verif|otp|sms|one[-_]?time|验证码/i;

const TYPED = new Set([
  'typed',
  'auto_bookmark',
  'generated',
  'start_page',
  'keyword',
  'keyword_generated',
]);

function urlPattern(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}*`;
  } catch {
    return `${url}*`;
  }
}

export class RecordingSession {
  private state: RecordingView = { status: 'idle', steps: [] };
  private tabs = new Set<number>();
  /** 新开标签页在首次提交导航前，等待记录 switchTab */
  private pendingNewTabs = new Set<number>();
  private lastTab: number | undefined;
  private counter = 0;
  /** 本地个人信息的值 -> 键名，录制开始时载入，用于把输入值替换成占位符 */
  private profileIndex = new Map<string, string>();

  constructor(
    private opts: {
      changed(): void;
      isHandoff(tabId: number): boolean;
    },
  ) {
    browser.webNavigation.onCommitted.addListener((d) => this.onCommitted(d));
    browser.tabs.onCreated.addListener((tab) => this.onTabCreated(tab));
    browser.tabs.onActivated.addListener((a) => this.onActivated(a.tabId));
  }

  view(): RecordingView {
    return { ...this.state, steps: this.state.steps };
  }

  get isRecording(): boolean {
    return this.state.status === 'recording';
  }

  isRecordingTab(tabId: number): boolean {
    return this.isRecording && this.tabs.has(tabId);
  }

  async start(tabId: number, profileIndex: Map<string, string>): Promise<void> {
    if (this.state.status === 'recording') throw new Error('已在录制中');
    this.profileIndex = profileIndex;
    this.counter = 0;
    this.tabs = new Set([tabId]);
    this.pendingNewTabs.clear();
    this.lastTab = tabId;
    this.state = { status: 'recording', tabId, startedAt: Date.now(), steps: [] };
    const tab = await browser.tabs.get(tabId);
    if (tab.url) this.add({ type: 'open', url: tab.url });
    await this.toggleRecorder(tabId, true);
    this.opts.changed();
  }

  async stop(): Promise<void> {
    if (this.state.status !== 'recording') return;
    for (const id of this.tabs) await this.toggleRecorder(id, false);
    this.state = { ...this.state, status: 'review' };
    this.tabs.clear();
    this.opts.changed();
  }

  setSteps(steps: Step[]): void {
    if (this.state.status !== 'review') return;
    this.state = { ...this.state, steps: steps.map((s) => stepSchema.parse(s)) };
    this.opts.changed();
  }

  takeSteps(): { steps: Step[]; startedAt: number } {
    if (this.state.status !== 'review') throw new Error('没有可上报的录制');
    const out = { steps: this.state.steps, startedAt: this.state.startedAt ?? Date.now() };
    this.discard();
    return out;
  }

  discard(): void {
    this.tabs.clear();
    this.state = { status: 'idle', steps: [] };
    this.opts.changed();
  }

  /** 页面（或子 frame）加载后重新打开录制监听 */
  async onContentLoaded(tabId: number, frameId: number): Promise<void> {
    if (!this.isRecordingTab(tabId)) return;
    await browser.tabs
      .sendMessage(
        tabId,
        { type: CONTENT_MESSAGE, command: { cmd: 'recorder', on: true } },
        { frameId },
      )
      .catch(() => undefined);
  }

  onRecorded(tabId: number, action: RecordedAction): void {
    if (!this.isRecordingTab(tabId) || this.opts.isHandoff(tabId)) return;
    const id = this.nextId();
    switch (action.kind) {
      case 'click':
        this.addStep({ id, type: 'click', target: action.locator });
        break;
      case 'fill': {
        if (action.sensitive && USER_INPUT_FIELD.test(action.fieldName)) {
          // 输入框填满（有 maxlength 时达到它，否则非空）就自动继续，侧边栏的「继续」仍可手动继续
          this.addStep({
            id,
            type: 'handoff',
            message: '请在页面上输入验证码；输完会自动继续，也可以点「继续」',
            resumeWhen: 'condition',
            until: { kind: 'element', target: action.locator, filled: true },
          });
          break;
        }
        const value = action.sensitive
          ? `{{secret.${action.fieldName}}}`
          : this.maskProfile(action.value);
        this.addStep({ id, type: 'fill', target: action.locator, value });
        break;
      }
      case 'select':
        this.addStep({ id, type: 'select', target: action.locator, value: action.value });
        break;
      case 'check':
        this.addStep({ id, type: 'check', target: action.locator, checked: action.checked });
        break;
      case 'press':
        this.addStep({ id, type: 'press', key: action.key, target: action.locator });
        break;
    }
  }

  // ---- 内部 ----

  private maskProfile(value: string): string {
    const key = this.profileIndex.get(value);
    return key ? `{{profile.${key}}}` : value;
  }

  private nextId(): string {
    this.counter++;
    return `r${this.counter}`;
  }

  private add(step: Record<string, unknown>): void {
    this.addStep({ id: this.nextId(), ...step });
  }

  private addStep(raw: Record<string, unknown>): void {
    this.state = { ...this.state, steps: [...this.state.steps, stepSchema.parse(raw)] };
    this.opts.changed();
  }

  private async toggleRecorder(tabId: number, on: boolean): Promise<void> {
    await browser.tabs
      .sendMessage(tabId, { type: CONTENT_MESSAGE, command: { cmd: 'recorder', on } })
      .catch(() => undefined);
  }

  private onCommitted(d: { tabId: number; frameId: number; url: string; transitionType: string }) {
    if (!this.isRecording || d.frameId !== 0 || !this.tabs.has(d.tabId)) return;
    if (this.pendingNewTabs.delete(d.tabId)) {
      this.lastTab = d.tabId;
      this.add({ type: 'switchTab', urlPattern: urlPattern(d.url) });
      return;
    }
    if (d.url === 'about:blank') return;
    if (TYPED.has(d.transitionType)) this.add({ type: 'open', url: d.url });
    else if (d.transitionType === 'link' || d.transitionType === 'form_submit') {
      this.add({ type: 'waitFor', until: 'navigation', urlPattern: urlPattern(d.url) });
    }
  }

  private onTabCreated(tab: { id?: number; openerTabId?: number }) {
    if (!this.isRecording || tab.id === undefined || tab.openerTabId === undefined) return;
    if (!this.tabs.has(tab.openerTabId)) return;
    this.tabs.add(tab.id);
    this.pendingNewTabs.add(tab.id);
    this.add({ type: 'waitFor', until: 'newTab' });
  }

  private onActivated(tabId: number) {
    if (!this.isRecording || !this.tabs.has(tabId) || this.pendingNewTabs.has(tabId)) return;
    if (tabId === this.lastTab) return;
    this.lastTab = tabId;
    void browser.tabs.get(tabId).then((tab) => {
      if (tab.url) this.add({ type: 'switchTab', urlPattern: urlPattern(tab.url) });
    });
  }
}
