// bridge-client.js 的最小类型声明（js 文件从 claude-bridge 原样复制，不改）。用到哪些再补哪些。

export class BridgeAuthError extends Error {}

export interface BridgeClientOptions {
  baseUrl?: string;
  fetch?: (url: string, opts?: RequestInit) => Promise<Response>;
  onAuthLost?: () => void;
  pollInterval?: number;
  idlePollInterval?: number;
}

export interface SendOptions {
  thread?: string | null;
  scope?: string;
  key?: string;
  newThread?: boolean;
  ephemeral?: boolean;
  /** upload() 返回的 id */
  files?: string[];
  /** 只对这一轮生效的选项 */
  options?: {
    instructions?: string;
    model?: string;
    effort?: string;
    max_turns?: number;
  } | null;
}

export interface SendResult {
  thread: string;
  message_id: number;
  job_id: number;
  agent_online: boolean;
}

export interface UploadResult {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export class BridgeClient {
  constructor(opts?: BridgeClientOptions);
  baseUrl: string;
  status(): Promise<Record<string, unknown>>;
  send(text: string, opts?: SendOptions): Promise<SendResult>;
  upload(blob: Blob, opts?: { name?: string }): Promise<UploadResult>;
  fileUrl(id: string): string;
  deleteThread(id: string, scope?: string | null): Promise<unknown>;
}
