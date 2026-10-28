import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type WebSocket, WebSocketServer } from 'ws';

/**
 * 本地假后台：实现 docs/protocol.md 中扩展用到的接口，同时充当门户（/api/login 等），
 * 并托管 tests/e2e/pages 下的测试页面。每个测试一个实例，监听随机端口。
 *
 * 身份沿用门户网页会话：登录成功后下发 `portal_session` cookie，之后的 /api/me 与
 * /api/ext/* 只认这个 cookie（WebSocket 在握手时校验）。
 */

export const SESSION_COOKIE = 'portal_session';

const PAGES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pages');

export type RawRule = Record<string, unknown>;

/** 上行消息：只关心 kind 与少量公共字段，其余按需读取 */
export interface UplinkMessage {
  v: number;
  kind: string;
  id: string;
  [key: string]: unknown;
}

interface Waiter {
  kind: string;
  predicate: (msg: UplinkMessage) => boolean;
  resolve: (msg: UplinkMessage) => void;
}

/** 按 kind 收集上行消息 */
export class Received {
  readonly all: UplinkMessage[] = [];
  private waiters = new Set<Waiter>();

  add(msg: UplinkMessage): void {
    this.all.push(msg);
    for (const w of this.waiters) {
      if (w.kind === msg.kind && w.predicate(msg)) {
        this.waiters.delete(w);
        w.resolve(msg);
      }
    }
  }

  of(kind: string): UplinkMessage[] {
    return this.all.filter((m) => m.kind === kind);
  }

  /** 等待一条符合条件的消息（已收到的也算） */
  waitFor(
    kind: string,
    predicate: (msg: UplinkMessage) => boolean = () => true,
    timeoutMs = 20_000,
  ): Promise<UplinkMessage> {
    const existing = this.all.find((m) => m.kind === kind && predicate(m));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        kind,
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`等待上行消息 ${kind} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }
}

interface LogEntry {
  seq: number;
  msg: Record<string, unknown>;
}

export interface FakeBackendOptions {
  /** 后台主动发送 ping 的间隔 */
  pingIntervalMs?: number;
  /**
   * 会话 cookie 的 SameSite，默认 None（同时带 Secure）。
   * 实测（Chromium）：扩展 service worker 对有主机权限站点的 fetch 会带上 Lax / Strict cookie，
   * 但 WebSocket 握手只带 SameSite=None 的 cookie。Chromium 把 127.0.0.1 / localhost 视为
   * 安全上下文，http 下也接受 Secure cookie
   */
  cookieSameSite?: 'None' | 'Lax';
}

export class FakeBackend {
  /** 测试账号（随机生成，只在内存里比对，不打印） */
  readonly account = {
    username: `e2e-${randomBytes(4).toString('hex')}`,
    password: randomBytes(18).toString('base64url'),
  };
  /** 门户登录接口返回的用户 id；后台 /api/me 返回的 sub 与之不同，用于验证扩展以 sub 为准 */
  readonly portalUserId = 1001;
  readonly sub = 'e2e-user';
  readonly received = new Received();
  /** 已确认的下行序号 */
  readonly acks: number[] = [];
  /** 登录页提交的表单（只在内存里比对，不打印） */
  readonly loginSubmissions: Record<string, string>[] = [];
  /** booking.html 每次加载的时间戳 */
  readonly bookingLoads: number[] = [];
  /** 每个 WebSocket 连接建立的时间 */
  readonly wsConnections: number[] = [];
  /**
   * 各接口收到的请求：ws 为 WebSocket 握手次数，stream 与 poll 记录 since 参数，
   * uplink 记录消息 kind；login 记录结果，logout / me 记录次数；
   * unauthorized 记录因会话无效被拒绝的路径
   */
  readonly requests = {
    ws: 0,
    stream: [] as number[],
    poll: [] as number[],
    uplink: [] as string[],
    login: [] as ('ok' | 'invalid')[],
    logout: 0,
    me: 0,
    unauthorized: [] as string[],
  };
  /**
   * 故障开关，用于测试传输层回退：
   * - ws：WebSocket 握手返回 500
   * - stream：SSE 端点返回 500
   * - poll：轮询端点返回 500
   */
  readonly fail = { ws: false, stream: false, poll: false };
  /** GET /api/ai/status 的响应；null 表示后台没有这个接口（404） */
  aiStatus: {
    available: boolean;
    model?: string;
    bridgeUrl: string | null;
    scope?: string;
  } | null = null;
  /** /api/ai/status 被请求的次数 */
  aiStatusRequests = 0;

  private server: Server;
  private wss = new WebSocketServer({ noServer: true });
  private sockets = new Set<WebSocket>();
  private sseClients = new Set<ServerResponse>();
  private rawSockets = new Set<Socket>();
  /** 有效会话：cookie 值 → sub */
  private sessions = new Map<string, string>();
  private rules = new Map<string, RawRule>();
  private log: LogEntry[] = [];
  private seq = 0;
  private pingTimer: ReturnType<typeof setInterval>;
  private port = 0;
  private cookieAttributes: string;

  private constructor(opts: FakeBackendOptions) {
    this.cookieAttributes =
      (opts.cookieSameSite ?? 'None') === 'None'
        ? 'Path=/; HttpOnly; Secure; SameSite=None'
        : 'Path=/; HttpOnly; SameSite=Lax';
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
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as Socket, head));
    this.pingTimer = setInterval(() => {
      this.broadcastWs({ v: 1, kind: 'ping', id: randomUUID() });
    }, opts.pingIntervalMs ?? 5000);
  }

  static async start(opts: FakeBackendOptions = {}): Promise<FakeBackend> {
    const b = new FakeBackend(opts);
    await new Promise<void>((resolve) => b.server.listen(0, '127.0.0.1', resolve));
    b.port = (b.server.address() as AddressInfo).port;
    return b;
  }

  /** 同一服务的不同源：127.0.0.1 与 localhost 在浏览器里是两个不同的 origin */
  origin(host: '127.0.0.1' | 'localhost' = '127.0.0.1'): string {
    return `http://${host}:${this.port}`;
  }

  get url(): string {
    return this.origin();
  }

  get currentSeq(): number {
    return this.seq;
  }

  get connectedClients(): number {
    return this.sockets.size + this.sseClients.size;
  }

  // ---- 测试 API ----

  pushRule(rule: RawRule): number {
    this.rules.set(String(rule.id), rule);
    return this.emit({ kind: 'ruleUpsert', rule });
  }

  removeRule(ruleId: string): number {
    this.rules.delete(ruleId);
    return this.emit({ kind: 'ruleRemove', ruleId });
  }

  pushSnapshot(rules: RawRule[]): number {
    this.rules = new Map(rules.map((r) => [String(r.id), r]));
    return this.emit({ kind: 'snapshot', rules });
  }

  /** 请求是否带有效的门户会话 cookie（假 bridge 用它判断登录；cookie 不区分端口） */
  isSignedIn(req: IncomingMessage): boolean {
    return this.sessionOf(req) !== undefined;
  }

  /** 当前有效会话数 */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * 使所有会话失效（模拟门户会话过期），之后带旧 cookie 的请求都返回 401。
   * closeCode 给出时，已建立的 WebSocket 以该关闭码断开（4401 表示需要重新认证）
   */
  expireSessions(opts: { closeCode?: number } = {}): void {
    this.sessions.clear();
    if (opts.closeCode !== undefined) {
      for (const ws of this.sockets) ws.close(opts.closeCode, 'session expired');
    }
  }

  /** 断开所有实时连接（模拟网络中断），扩展应自动重连 */
  dropConnections(): void {
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
    for (const res of this.sseClients) res.destroy();
    this.sseClients.clear();
  }

  async close(): Promise<void> {
    clearInterval(this.pingTimer);
    this.dropConnections();
    this.wss.close();
    for (const s of this.rawSockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---- 同步 ----

  private emit(body: Record<string, unknown>): number {
    this.seq++;
    const msg = { v: 1, id: randomUUID(), seq: this.seq, ...body };
    this.log.push({ seq: this.seq, msg });
    this.broadcast(msg);
    return this.seq;
  }

  private snapshot(): Record<string, unknown> {
    return {
      v: 1,
      kind: 'snapshot',
      id: randomUUID(),
      seq: this.seq,
      rules: [...this.rules.values()],
    };
  }

  /** 按客户端序号补发增量；无法补齐时发送全量 */
  private catchUp(lastSeq: number | undefined): Record<string, unknown>[] {
    if (lastSeq && lastSeq > 0 && lastSeq <= this.seq) {
      return this.log.filter((e) => e.seq > lastSeq).map((e) => e.msg);
    }
    return [this.snapshot()];
  }

  private broadcast(msg: Record<string, unknown>): void {
    this.broadcastWs(msg);
    for (const res of this.sseClients) res.write(`data: ${JSON.stringify(msg)}\n\n`);
  }

  private broadcastWs(msg: Record<string, unknown>): void {
    const text = JSON.stringify(msg);
    for (const ws of this.sockets) ws.send(text);
  }

  private onUplink(msg: UplinkMessage, reply?: (m: Record<string, unknown>) => void): void {
    this.received.add(msg);
    switch (msg.kind) {
      case 'hello':
        for (const m of this.catchUp(msg.lastSeq as number | undefined)) reply?.(m);
        return;
      case 'resync':
        reply?.(this.snapshot());
        return;
      case 'ack':
        this.acks.push(msg.seq as number);
        return;
      case 'ping':
        reply?.({ v: 1, kind: 'pong', id: randomUUID() });
        return;
    }
  }

  // ---- HTTP ----

  /** 请求所带会话对应的 sub；无 cookie 或会话无效时为 undefined */
  private sessionOf(req: IncomingMessage): string | undefined {
    const value = cookieOf(req, SESSION_COOKIE);
    return value ? this.sessions.get(value) : undefined;
  }

  private reject(req: IncomingMessage, res: ServerResponse, p: string): void {
    this.requests.unauthorized.push(p);
    // 浏览器会话失效时常见的形态：401 + JSON
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    req.resume();
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;

    if (p === '/api/login' && req.method === 'POST') {
      let body: { username?: unknown; password?: unknown } = {};
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        // 按错误凭据处理
      }
      if (body.username !== this.account.username || body.password !== this.account.password) {
        this.requests.login.push('invalid');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_credentials' }));
        return;
      }
      this.requests.login.push('ok');
      const value = randomBytes(24).toString('hex');
      this.sessions.set(value, this.sub);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `${SESSION_COOKIE}=${value}; ${this.cookieAttributes}`,
      });
      res.end(
        JSON.stringify({ ok: true, id: this.portalUserId, user: body.username, role: 'member' }),
      );
      return;
    }

    if (p === '/api/logout' && req.method === 'POST') {
      this.requests.logout++;
      const value = cookieOf(req, SESSION_COOKIE);
      if (value) this.sessions.delete(value);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `${SESSION_COOKIE}=; Max-Age=0; ${this.cookieAttributes}`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (p === '/api/me' && req.method === 'GET') {
      this.requests.me++;
      const sub = this.sessionOf(req);
      if (!sub) {
        this.reject(req, res, p);
        return;
      }
      json(res, { sub, role: 'member' });
      return;
    }

    if (p === '/api/ai/status' && req.method === 'GET') {
      if (!this.sessionOf(req)) {
        this.reject(req, res, p);
        return;
      }
      this.aiStatusRequests++;
      if (!this.aiStatus) {
        res.writeHead(404);
        res.end();
        return;
      }
      json(res, { model: null, scope: 'pagepilot', ...this.aiStatus });
      return;
    }

    if (p.startsWith('/api/ext/')) {
      if (!this.sessionOf(req)) {
        this.reject(req, res, p);
        return;
      }
      if (p === '/api/ext/stream' && req.method === 'GET') {
        this.requests.stream.push(Number(url.searchParams.get('since') ?? 0));
        if (this.fail.stream) {
          res.writeHead(500).end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        for (const m of this.catchUp(Number(url.searchParams.get('since') ?? 0))) {
          res.write(`data: ${JSON.stringify(m)}\n\n`);
        }
        this.sseClients.add(res);
        req.on('close', () => this.sseClients.delete(res));
        return;
      }
      if (p === '/api/ext/poll' && req.method === 'GET') {
        this.requests.poll.push(Number(url.searchParams.get('since') ?? 0));
        if (this.fail.poll) {
          res.writeHead(500).end();
          return;
        }
        json(res, { messages: this.catchUp(Number(url.searchParams.get('since') ?? 0)) });
        return;
      }
      if (p === '/api/ext/uplink' && req.method === 'POST') {
        const msg = JSON.parse(await readBody(req)) as UplinkMessage;
        this.requests.uplink.push(msg.kind);
        // SSE / 轮询模式下 hello 的补发已经由 since 参数完成，这里只记录
        this.onUplink(msg);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(404).end();
      return;
    }

    if (p === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      this.loginSubmissions.push(Object.fromEntries(form));
      res.writeHead(303, { Location: '/pages/account.html' }).end();
      return;
    }

    const page = /^\/pages\/([a-z0-9-]+\.html)$/.exec(p)?.[1];
    if (page && req.method === 'GET') {
      let html: string;
      try {
        html = await readFile(path.join(PAGES_DIR, page), 'utf8');
      } catch {
        res.writeHead(404).end();
        return;
      }
      if (page === 'booking.html') {
        // 由服务端按加载次数决定是否出现名额，保证确定性
        this.bookingLoads.push(Date.now());
        const after = Number(url.searchParams.get('availableAfter') ?? 3);
        const available = this.bookingLoads.length >= after;
        html = html
          .replace('<!--LOAD-->', String(this.bookingLoads.length))
          .replace(
            '<!--SLOTS-->',
            available
              ? '<button class="slot available" id="slot-1">10:00</button>'
              : '<p class="slot full">暂无名额</p>',
          );
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    res.writeHead(404).end();
  }

  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/api/ext/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    this.requests.ws++;
    // 握手阶段校验会话 cookie，无效则拒绝握手
    if (!this.sessionOf(req)) {
      this.requests.unauthorized.push(url.pathname);
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    if (this.fail.ws) {
      socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.sockets.add(ws);
      this.wsConnections.push(Date.now());
      ws.on('close', () => this.sockets.delete(ws));
      ws.on('message', (data) => {
        let msg: UplinkMessage;
        try {
          msg = JSON.parse(String(data)) as UplinkMessage;
        } catch {
          return;
        }
        this.onUplink(msg, (m) => ws.send(JSON.stringify(m)));
      });
    });
  }
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
