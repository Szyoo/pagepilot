// bridge-widget.js 的最小类型声明（js 文件从 claude-bridge 原样复制，不改）。只声明用到的部分。

import type { BridgeClient } from './bridge-client.js';

export interface BridgeWidgetOptions {
  scope?: string;
  title?: string;
  showThreads?: boolean;
  showSettings?: boolean;
  /** 组件铺满容器（容器需要有确定的高度） */
  fill?: boolean;
  locale?: string;
  placeholder?: string;
  strings?: Record<string, string>;
  markdown?: (text: string) => string;
  /** 界面偏好在 localStorage 里的键 */
  prefsKey?: string;
  /** 语音输入；false 关闭 */
  voice?: boolean | Record<string, unknown>;
}

export interface BridgeWidget {
  destroy(): void;
  openThread(id: string): Promise<void>;
  refresh(): void;
  readonly thread: string | null;
  readonly input: HTMLTextAreaElement;
}

export function mountBridgeWidget(
  el: HTMLElement,
  client: BridgeClient,
  opts?: BridgeWidgetOptions,
): BridgeWidget;
