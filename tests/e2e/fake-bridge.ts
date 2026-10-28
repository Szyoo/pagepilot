import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * 本地假 claude-bridge：只实现 vendor 的 bridge-client.js / bridge-widget.js 在「请 AI 看看」里实际调用的
 * 浏览器接口（base 为 `/api`）。每个请求都要带有效的门户会话 cookie（由 authorize 判断），否则返回 401。
 * 收到的消息与上传的文件记在 sends / uploads 里供断言；助手回复固定为 replyFor(text)。
 */

export interface SentMessage {
  path: string;
  thread: string;
  text: string;
  scope: string;
  newThread: boolean;
  files: string[];
  options: Record<string, unknown> | null;
}

export interface Upload {
  id: string;
  name: string;
  mime: string;
  bytes: Buffer;
}

interface Msg {
  id: number;
  thread: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'pending' | 'streaming' | 'done';
  rev: number;
  created_at: string;
  events: unknown[];
  files: { id: string; name: string; mime: string; size: number }[];
}

interface Thread {
  id: string;
  scope: string;
  title: string;
  messages: Msg[];
}

export interface FakeBridgeOptions {
  /** 请求是否带有效的门户会话 */
  authorize: (req: IncomingMessage) => boolean;
  /** 助手对一条用户消息的回复 */
  replyFor?: (text: string, index: number) => string;
}

const nowUtc = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

export class FakeBridge {
  readonly sends: SentMessage[] = [];
  readonly uploads: Upload[] = [];
  /** 每个请求的方法与路径（不含查询串），按顺序 */
  readonly requests: string[] = [];
  /** 被拒绝（401）的请求数 */
  rejected = 0;

  private server: Server;
  private rawSockets = new Set<Socket>();
  private threads = new Map<string, Thread>();
  private current = new Map<string, string>();
  private streams = new Map<string, Set<ServerResponse>>();
  private nextMsg = 1;
  private nextThread = 1;
  private nextEvent = 1;
  private port = 0;
  private opts: FakeBridgeOptions;

  private constructor(opts: FakeBridgeOptions) {
    this.opts = opts;
    this.server = createServer((req, res) => {
      this.route(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    this.server.on('connection', (s) => {
      this.rawSockets.add(s);
      s.on('close', () => this.rawSockets.delete(s));
    });
  }

  static async start(opts: FakeBridgeOptions): Promise<FakeBridge> {
    const b = new FakeBridge(opts);
    await new Promise<void>((resolve) => b.server.listen(0, '127.0.0.1', resolve));
    b.port = (b.server.address() as AddressInfo).port;
    return b;
  }

  /** 扩展设置里的 bridgeUrl */
  get url(): string {
    return `http://127.0.0.1:${this.port}/api`;
  }

  async close(): Promise<void> {
    for (const set of this.streams.values()) for (const r of set) r.destroy();
    for (const s of this.rawSockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** 等到收到第 n 条（从 1 起）消息 */
  async waitForSend(n: number, timeoutMs = 20_000): Promise<SentMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const m = this.sends[n - 1];
      if (m) return m;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`等待假 bridge 收到第 ${n} 条消息超时`);
  }

  // ---- HTTP ----

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = u.pathname;
    const method = req.method ?? 'GET';
    this.requests.push(`${method} ${p}`);
    if (!p.startsWith('/api/')) return json(res, 404, { detail: 'not found' });
    if (!this.opts.authorize(req)) {
      this.rejected++;
      return json(res, 401, { detail: '未登录' });
    }
    const path = p.slice(4);

    if (method === 'GET' && path === '/status') {
      return json(res, 200, { online: true, worker: 'fake', queued: 0, running: 0, bridge: {} });
    }
    if (path === '/settings') {
      return json(res, 200, {
        chat: { model: '', effort: '', max_turns: 40, auto_context: false },
        models: [],
        models_info: {},
        bridge: {},
        efforts: [''],
        agent: { online: true, worker: 'fake' },
        uploads: { enabled: true, max_bytes: 10 * 1024 * 1024, max_files: 5 },
      });
    }
    if (method === 'GET' && path === '/threads') {
      const scope = u.searchParams.get('scope') ?? '';
      const items = [...this.threads.values()]
        .filter((t) => t.scope === scope)
        .map((t) => ({ id: t.id, title: t.title, n: t.messages.length, pinned: false }));
      return json(res, 200, { items, current: this.current.get(scope) ?? null, scope });
    }
    if (method === 'POST' && path === '/send') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const scope = String(body.scope ?? '');
      let tid = this.current.get(scope);
      if (body.new_thread || !tid) tid = this.newThread(scope);
      return this.chat(res, path, tid, body, scope, Boolean(body.new_thread));
    }
    if (method === 'POST' && path === '/files') {
      const bytes = await readRaw(req);
      const id = `f${this.uploads.length + 1}`;
      const name = u.searchParams.get('name') ?? '';
      const mime = String(req.headers['content-type'] ?? 'application/octet-stream');
      this.uploads.push({ id, name, mime, bytes });
      return json(res, 201, { id, name, mime, size: bytes.length });
    }
    const fileMatch = /^\/files\/([^/]+)$/.exec(path);
    if (method === 'GET' && fileMatch) {
      const f = this.uploads.find((x) => x.id === decodeURIComponent(fileMatch[1] ?? ''));
      if (!f) return json(res, 404, { detail: '没有这个文件' });
      res.writeHead(200, { 'Content-Type': f.mime });
      res.end(f.bytes);
      return;
    }
    const m = /^\/threads\/([^/]+)(\/.*)?$/.exec(path);
    if (m) {
      const t = this.threads.get(decodeURIComponent(m[1] ?? ''));
      if (!t) return json(res, 404, { detail: '没有这个对话' });
      const rest = m[2] ?? '';
      if (method === 'GET' && rest === '') return json(res, 200, this.snapshot(t));
      if (method === 'POST' && rest === '/select') {
        this.current.set(t.scope, t.id);
        return json(res, 200, { thread: t.id });
      }
      if (method === 'GET' && rest === '/messages') {
        const after = Number(u.searchParams.get('after') ?? 0);
        return json(res, 200, { items: t.messages.filter((x) => x.id > after), inflight: null });
      }
      if (method === 'POST' && rest === '/messages') {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        return this.chat(res, path, t.id, body, t.scope, false);
      }
      if (method === 'GET' && rest === '/stream') return this.stream(res, t);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { detail: 'not found' });
  }

  private newThread(scope: string): string {
    const id = `t${this.nextThread++}`;
    this.threads.set(id, { id, scope, title: '', messages: [] });
    this.current.set(scope, id);
    return id;
  }

  private snapshot(t: Thread) {
    const inflight = t.messages.find((x) => x.status !== 'done');
    return {
      thread: { id: t.id, scope: t.scope, title: t.title, pinned: false },
      messages: t.messages,
      inflight: inflight?.id ?? null,
      agent: { online: true, worker: 'fake' },
      jobs: [],
      cursor: this.nextEvent,
    };
  }

  private chat(
    res: ServerResponse,
    path: string,
    tid: string,
    body: Record<string, unknown>,
    scope: string,
    newThread: boolean,
  ): void {
    const t = this.threads.get(tid) as Thread;
    const text = String(body.text ?? '');
    const files = Array.isArray(body.files) ? body.files.map(String) : [];
    this.sends.push({
      path,
      thread: tid,
      text,
      scope,
      newThread,
      files,
      options: (body.options as Record<string, unknown> | undefined) ?? null,
    });
    if (!t.title) t.title = text.slice(0, 20);
    const user: Msg = {
      id: this.nextMsg++,
      thread: tid,
      role: 'user',
      content: text,
      status: 'done',
      rev: 0,
      created_at: nowUtc(),
      events: [],
      files: files.map((id) => {
        const f = this.uploads.find((x) => x.id === id);
        return { id, name: f?.name ?? '', mime: f?.mime ?? '', size: f?.bytes.length ?? 0 };
      }),
    };
    const asst: Msg = {
      id: this.nextMsg++,
      thread: tid,
      role: 'assistant',
      content: '',
      status: 'pending',
      rev: 0,
      created_at: nowUtc(),
      events: [],
      files: [],
    };
    t.messages.push(user, asst);
    this.publish(tid, 'message', user);
    this.publish(tid, 'message', asst);
    const index = this.sends.length;
    setTimeout(() => {
      asst.content = (this.opts.replyFor ?? defaultReply)(text, index);
      asst.status = 'done';
      asst.rev = 1;
      this.publish(tid, 'message', asst);
      this.publish(tid, 'done', { message_id: asst.id, status: 'done' });
    }, 300);
    json(res, 201, { message_id: asst.id, job_id: asst.id, thread: tid, agent_online: true });
  }

  private stream(res: ServerResponse, t: Thread): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let set = this.streams.get(t.id);
    if (!set) {
      set = new Set();
      this.streams.set(t.id, set);
    }
    set.add(res);
    res.on('close', () => set?.delete(res));
    res.write(frame('snapshot', this.snapshot(t), this.nextEvent));
  }

  private publish(tid: string, event: string, data: unknown): void {
    const id = this.nextEvent++;
    for (const r of this.streams.get(tid) ?? []) r.write(frame(event, data, id));
  }
}

const defaultReply = (_text: string, index: number) =>
  index === 1
    ? '看起来页面上找不到要点的按钮，建议先手动处理再点「重试这一步」。'
    : `收到第 ${index} 条。`;

function frame(event: string, data: unknown, id: number): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return (await readRaw(req)).toString('utf8');
}
