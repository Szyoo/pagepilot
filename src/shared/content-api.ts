import type { CaptureElement } from '../schema/message';
import type { Condition, Locator } from '../schema/rule';

/** background -> content 的命令 */
export type ContentCommand =
  | { cmd: 'ping' }
  | { cmd: 'probe'; locator: Locator; ignoreFrame?: boolean }
  | { cmd: 'condition'; condition: Condition }
  | { cmd: 'act'; act: Act; locator?: Locator; ignoreFrame?: boolean }
  | {
      cmd: 'prepare';
      locator: Locator;
      ignoreFrame?: boolean;
      focus?: boolean;
      selectContent?: boolean;
    }
  | { cmd: 'frameOffset'; url: string }
  | { cmd: 'captcha' }
  | { cmd: 'idle' }
  | { cmd: 'capture' }
  /** 只给「请 AI 看看」用的页面概要，不上报后台 */
  | { cmd: 'inspect' }
  | { cmd: 'recorder'; on: boolean };

export type Act =
  | { action: 'click' }
  | { action: 'fill'; value: string; clear: boolean }
  | { action: 'select'; value: string }
  | { action: 'check'; checked: boolean }
  | { action: 'press'; key: string }
  | { action: 'extract'; attr?: string | undefined };

export interface ProbeResult {
  /** crossOrigin：定位链经过无法访问的 iframe，需要由子 frame 自己解析 */
  status: 'ok' | 'crossOrigin';
  count: number;
  visible: boolean;
  text: string;
}

export type ActResult =
  | { ok: true; value?: string }
  | { ok: false; code: 'TARGET_NOT_FOUND' | 'INTERNAL'; message?: string };

export type PrepareResult =
  | { ok: true; x: number; y: number; tag: string; checked?: boolean }
  | { ok: false; code: 'TARGET_NOT_FOUND' | 'INTERNAL' };

export interface PingResult {
  ready: true;
  isTop: boolean;
  url: string;
}

/** content -> background 的事件 */
export type ContentEvent =
  | { event: 'recorded'; record: RecordedAction; url: string }
  | { event: 'loaded'; url: string; isTop: boolean };

export type RecordedAction =
  | { kind: 'click'; locator: Locator }
  | {
      kind: 'fill';
      locator: Locator;
      value: string;
      /** 敏感字段（密码、支付、验证码等）：值由后台替换成占位符 */
      sensitive: boolean;
      /** 验证码、短信验证码这类当场输入的字段：录成交还给用户的步骤 */
      userCode: boolean;
      fieldName: string;
    }
  | { kind: 'select'; locator: Locator; value: string }
  | { kind: 'check'; locator: Locator; checked: boolean }
  | { kind: 'press'; locator: Locator; key: string };

export interface CaptureResult {
  elements: CaptureElement[];
  title: string;
}

/** 页面概要里的一个元素：不带属性、定位器与任何输入值；敏感元素不带文字 */
export interface InspectElement {
  tag: string;
  role?: string;
  /** 名称或文字，最多 60 字 */
  text?: string;
  sensitive: boolean;
}

export interface InspectResult {
  elements: InspectElement[];
}

export const CONTENT_MESSAGE = 'pagepilot:content';
export const EVENT_MESSAGE = 'pagepilot:event';
