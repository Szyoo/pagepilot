import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { type AddressInfo, connect, createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

/** 测试用的门户地址（不存在，管理页对它的请求由用例拦截） */
export const FAKE_PORTAL = 'https://portal.example.com';

/**
 * 假门卫：模拟生产环境里反向代理的 sso 片段与门户登录，前面挡着真实后台（server/，FastAPI）。
 *
 * - 启动真实后台：uvicorn 子进程，随机端口、临时 DATA_DIR、SZYYW_SSO=1，等待 /api/health 就绪；
 * - `POST /api/login` / `POST /api/logout`：门户登录，下发 / 清除 `portal_session` cookie；
 * - `/api/health` 放行；其余请求必须带有效 cookie，否则 401；有效时先剥掉客户端自带的身份头，
 *   再注入 `X-Portal-Sub` 与 `X-Role` 转发（SSE 流式转发不缓冲，WebSocket 握手同样校验与注入）；
 * - 同时托管 tests/e2e/pages 下的测试页面（`/pages/*` 与登录表单 `POST /login`），不经后台。
 *
 * 凭据都是随机假值，只在内存里比对，不打印。
 */

export const SESSION_COOKIE = 'portal_session';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAGES_DIR = path.join(ROOT, 'tests/e2e/pages');
const SERVER_DIR = path.join(ROOT, 'server');

/** 运行后台用的 Python（server/.venv），可用环境变量 PAGEPILOT_SERVER_PYTHON 覆盖 */
export const SERVER_PYTHON =
  process.env.PAGEPILOT_SERVER_PYTHON ?? path.join(SERVER_DIR, '.venv/bin/python');

export const serverAvailable = (): boolean => existsSync(SERVER_PYTHON);

/** 门卫剥掉的客户端身份头（Node 已转为小写） */
const IDENTITY_HEADERS = ['x-user', 'x-role', 'x-portal-sub', 'x-portal-anon'];

export type Role = 'user' | 'admin';

export interface GateUser {
  sub: string;
  role: Role;
  username: string;
  password: string;
}

/** 门卫看到的一次请求（不含 cookie 与请求体） */
export interface GateRequest {
  method: string;
  path: string;
  /** 门卫处理结果：转发后的状态码，或 401（未登录被拒），WebSocket 为 101 / 401 */
  status: number;
  sub?: string;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

/** 以某个用户身份经门卫调用后台接口 */
export interface UserClient {
  get<T = unknown>(p: string): Promise<ApiResponse<T>>;
  put<T = unknown>(p: string, body: unknown): Promise<ApiResponse<T>>;
  post<T = unknown>(p: string, body: unknown): Promise<ApiResponse<T>>;
  delete<T = unknown>(p: string): Promise<ApiResponse<T>>;
}

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** uvicorn 的日志配置：打开 pagepilot_server 的 INFO 日志（只含消息类型与 id），关掉访问日志 */
const LOG_CONFIG = {
  version: 1,
  disable_existing_loggers: false,
  formatters: { plain: { format: '%(levelname)s %(name)s %(message)s' } },
  handlers: {
    stderr: { class: 'logging.StreamHandler', formatter: 'plain', stream: 'ext://sys.stderr' },
  },
  loggers: {
    pagepilot_server: { level: 'INFO' },
    uvicorn: { level: 'INFO' },
    'uvicorn.access': { level: 'WARNING' },
  },
  root: { handlers: ['stderr'], level: 'WARNING' },
};

/** 真实后台子进程 */
class BackendProcess {
  log = '';
  private exited: Promise<number | null>;

  private constructor(
    readonly port: number,
    readonly dataDir: string,
    private proc: ChildProcess,
  ) {
    proc.stdout?.on('data', (d: Buffer) => {
      this.log += d.toString('utf8');
    });
    proc.stderr?.on('data', (d: Buffer) => {
      this.log += d.toString('utf8');
    });
    this.exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  }

  static async start(): Promise<BackendProcess> {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'pagepilot-server-'));
    const logConfig = path.join(dataDir, 'log-config.json');
    await writeFile(logConfig, JSON.stringify(LOG_CONFIG));
    const port = await freePort();
    const proc = spawn(
      SERVER_PYTHON,
      [
        '-m',
        'uvicorn',
        'pagepilot_server.app:create_app',
        '--factory',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--log-config',
        logConfig,
      ],
      {
        cwd: SERVER_DIR,
        env: {
          ...process.env,
          SZYYW_SSO: '1',
          DATA_DIR: dataDir,
          PYTHONUNBUFFERED: '1',
          // 管理页的设计包会向门户读账户信息；测试里指向一个假地址，由用例拦截
          PORTAL_URL: FAKE_PORTAL,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const b = new BackendProcess(port, dataDir, proc);
    try {
      await b.waitReady();
    } catch (e) {
      await b.stop();
      throw e;
    }
    return b;
  }

  private async waitReady(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let exitCode: number | null | undefined;
    void this.exited.then((c) => {
      exitCode = c;
    });
    while (Date.now() < deadline) {
      if (exitCode !== undefined) break;
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/api/health`);
        if (res.ok) return;
      } catch {
        // 尚未监听
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const reason = exitCode !== undefined ? `进程已退出（${exitCode}）` : `${timeoutMs}ms 内未就绪`;
    // 后台日志只含启动信息与消息类型，不含凭据
    throw new Error(`真实后台启动失败：${reason}\n---- 后台日志 ----\n${this.log}`);
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      this.proc.kill('SIGTERM');
      const timer = setTimeout(() => this.proc.kill('SIGKILL'), 5000);
      await this.exited;
      clearTimeout(timer);
    }
    await rm(this.dataDir, { recursive: true, force: true });
  }
}

export class Gate {
  /** 门卫处理过的请求（不含静态测试页面） */
  readonly requests: GateRequest[] = [];
  /** 测试页面登录表单提交的内容（只在内存里比对，不打印） */
  readonly loginSubmissions: Record<string, string>[] = [];

  private server: Server;
  private agent = new Agent({ keepAlive: false });
  private users = new Map<string, GateUser>();
  /** 有效会话：cookie 值 → sub */
  private sessions = new Map<string, string>();
  /** 长连接（SSE 响应与 WebSocket 隧道），dropConnections 时断开 */
  private live = new Set<{ destroy(): void }>();
  private rawSockets = new Set<Socket>();
  private port = 0;

  private constructor(private backend: BackendProcess) {
    this.server = createServer((req, res) => {
      this.route(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });
    this.server.on('connection', (s) => {
      this.rawSockets.add(s);
      s.on('close', () => this.rawSockets.delete(s));
    });
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as Socket, head));
  }

  /** 启动真实后台与门卫 */
  static async start(): Promise<Gate> {
    const backend = await BackendProcess.start();
    const gate = new Gate(backend);
    await new Promise<void>((resolve) => gate.server.listen(0, '127.0.0.1', resolve));
    gate.port = (gate.server.address() as AddressInfo).port;
    return gate;
  }

  origin(host: '127.0.0.1' | 'localhost' = '127.0.0.1'): string {
    return `http://${host}:${this.port}`;
  }

  get url(): string {
    return this.origin();
  }

  /** 后台进程的日志（INFO：上行消息类型与 id，不含内容） */
  get backendLog(): string {
    return this.backend.log;
  }

  /** 后台日志里记录的上行消息（已去重后真正处理的），按出现顺序 */
  uplinks(kind?: string): { kind: string; channel: string }[] {
    const out: { kind: string; channel: string }[] = [];
    for (const m of this.backend.log.matchAll(/上行 kind=(\w+) id=\S+ channel=(\w+)/g)) {
      if (!kind || m[1] === kind) out.push({ kind: m[1] ?? '', channel: m[2] ?? '' });
    }
    return out;
  }

  /** 直接读后台数据库里的用户行（只读）：下行序号与已确认序号 */
  userRow(sub: string): { seq: number; ackedSeq: number } | undefined {
    const db = this.openDb();
    try {
      const row = db.prepare('SELECT seq, acked_seq FROM users WHERE sub = ?').get(sub) as
        | { seq: number; acked_seq: number }
        | undefined;
      return row ? { seq: row.seq, ackedSeq: row.acked_seq } : undefined;
    } finally {
      db.close();
    }
  }

  /** 后台数据库所有表的全部行（JSON 文本），用于检查本地数据没有进入后台 */
  dumpDatabase(): string {
    const db = this.openDb();
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[];
      return JSON.stringify(
        tables.map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}"`).all()]),
      );
    } finally {
      db.close();
    }
  }

  private openDb(): DatabaseSync {
    return new DatabaseSync(path.join(this.backend.dataDir, 'pagepilot.db'), { readOnly: true });
  }

  /** 统计某个路径前缀的请求 */
  requestsTo(prefix: string, status?: number): GateRequest[] {
    return this.requests.filter(
      (r) => r.path.startsWith(prefix) && (status === undefined || r.status === status),
    );
  }

  // ---- 测试 API ----

  /** 新建门户账号（随机用户名与密码） */
  createUser(sub: string, role: Role = 'user'): GateUser {
    const user: GateUser = {
      sub,
      role,
      username: `e2e-${randomBytes(4).toString('hex')}`,
      password: randomBytes(18).toString('base64url'),
    };
    this.users.set(user.username, user);
    return user;
  }

  /** 直接为某个用户签发一个会话，返回 cookie 值 */
  issueSession(sub: string): string {
    const value = randomBytes(24).toString('hex');
    this.sessions.set(value, sub);
    return value;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** 使所有门户会话失效；之后带旧 cookie 的请求都返回 401（已建立的长连接不受影响） */
  expireSessions(): void {
    this.sessions.clear();
  }

  /** 断开所有经门卫的长连接（SSE 与 WebSocket），模拟网络中断 */
  dropConnections(): void {
    for (const c of this.live) c.destroy();
    this.live.clear();
  }

  /** 以某个用户身份经门卫调用后台（带有效 cookie，不带 Origin，相当于非浏览器客户端） */
  asUser(sub: string): UserClient {
    const call = async <T>(method: string, p: string, body?: unknown): Promise<ApiResponse<T>> => {
      const cookie = `${SESSION_COOKIE}=${this.issueSession(sub)}`;
      const res = await fetch(`${this.url}${p}`, {
        method,
        headers: {
          cookie,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // 非 JSON 原样返回
      }
      return { status: res.status, body: parsed as T };
    };
    return {
      get: (p) => call('GET', p),
      put: (p, body) => call('PUT', p, body),
      post: (p, body) => call('POST', p, body),
      delete: (p) => call('DELETE', p),
    };
  }

  async close(): Promise<void> {
    this.dropConnections();
    for (const s of this.rawSockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.agent.destroy();
    await this.backend.stop();
  }

  // ---- 门户 ----

  private userOf(req: IncomingMessage): GateUser | undefined {
    const value = cookieOf(req, SESSION_COOKIE);
    const sub = value ? this.sessions.get(value) : undefined;
    if (!sub) return undefined;
    for (const u of this.users.values()) if (u.sub === sub) return u;
    // asUser / issueSession 签发的会话可能对应未建账号的用户：按普通用户处理
    return { sub, role: 'user', username: '', password: '' };
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
      const user = typeof body.username === 'string' ? this.users.get(body.username) : undefined;
      if (!user || body.password !== user.password) {
        this.requests.push({ method: 'POST', path: p, status: 401 });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_credentials' }));
        return;
      }
      this.requests.push({ method: 'POST', path: p, status: 200, sub: user.sub });
      const value = this.issueSession(user.sub);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        // 与现有假后台一致；Chromium 把 127.0.0.1 视为安全上下文，http 下也接受 Secure
        'Set-Cookie': `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=None`,
      });
      res.end(
        JSON.stringify({ ok: true, id: user.username, user: user.username, role: user.role }),
      );
      return;
    }

    if (p === '/api/logout' && req.method === 'POST') {
      this.requests.push({ method: 'POST', path: p, status: 200 });
      const value = cookieOf(req, SESSION_COOKIE);
      if (value) this.sessions.delete(value);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ---- 测试站点（不经后台）----
    if (p === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      this.loginSubmissions.push(Object.fromEntries(form));
      res.writeHead(303, { Location: '/pages/account.html' }).end();
      return;
    }
    const page = /^\/pages\/([a-z-]+\.html)$/.exec(p)?.[1];
    if (page && req.method === 'GET') {
      try {
        const html = await readFile(path.join(PAGES_DIR, page), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
      } catch {
        res.writeHead(404).end();
      }
      return;
    }

    // ---- 后台 ----
    if (p === '/api/health') {
      this.proxy(req, res, undefined);
      return;
    }
    const user = this.userOf(req);
    if (!user) {
      this.requests.push({ method: req.method ?? 'GET', path: p, status: 401 });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      req.resume();
      return;
    }
    this.proxy(req, res, user);
  }

  private proxy(req: IncomingMessage, res: ServerResponse, user: GateUser | undefined): void {
    const entry: GateRequest = {
      method: req.method ?? 'GET',
      path: new URL(req.url ?? '/', 'http://x').pathname,
      status: 0,
      sub: user?.sub,
    };
    this.requests.push(entry);
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: this.backend.port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req.headers, user),
      agent: this.agent,
    });
    upstream.on('response', (up) => {
      entry.status = up.statusCode ?? 0;
      res.writeHead(up.statusCode ?? 502, up.headers);
      // 流式响应（SSE）：头先发出，之后每块数据到达即转发，不缓冲
      res.flushHeaders();
      const stream = String(up.headers['content-type'] ?? '').startsWith('text/event-stream');
      if (stream) {
        const conn = {
          destroy: () => {
            up.destroy();
            res.destroy();
          },
        };
        this.live.add(conn);
        res.on('close', () => this.live.delete(conn));
      }
      up.on('data', (chunk: Buffer) => res.write(chunk));
      up.on('end', () => res.end());
      up.on('error', () => res.destroy());
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    // 客户端断开（如扩展切换通道时中止 SSE）时同时断开到后台的请求
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }

  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    const user = this.userOf(req);
    if (!user) {
      // 握手阶段校验会话 cookie，无效则拒绝握手
      this.requests.push({ method: 'WS', path: p, status: 401 });
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    this.requests.push({ method: 'WS', path: p, status: 101, sub: user.sub });
    const upstream = connect(this.backend.port, '127.0.0.1');
    const conn = {
      destroy: () => {
        socket.destroy();
        upstream.destroy();
      },
    };
    this.live.add(conn);
    const cleanup = () => {
      this.live.delete(conn);
      conn.destroy();
    };
    socket.on('close', cleanup);
    upstream.on('close', cleanup);
    socket.on('error', cleanup);
    upstream.on('error', cleanup);
    upstream.on('connect', () => {
      const headers = forwardHeaders(req.headers, user);
      let raw = `${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) {
        for (const one of Array.isArray(v) ? v : [v]) {
          if (one !== undefined) raw += `${k}: ${one}\r\n`;
        }
      }
      upstream.write(`${raw}\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  }
}

/** 转发的请求头：剥掉客户端自带的身份头，有用户时注入门卫的身份头；Host 保持原样（后台按它判断同源） */
function forwardHeaders(
  headers: IncomingHttpHeaders,
  user: GateUser | undefined,
): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!IDENTITY_HEADERS.includes(k)) out[k] = v;
  }
  if (user) {
    out['x-portal-sub'] = user.sub;
    out['x-role'] = user.role;
  }
  return out;
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
