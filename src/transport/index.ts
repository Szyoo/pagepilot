import { browser } from 'wxt/browser';
import type { ApplyResult } from '../core/rules';
import {
  type Downlink,
  downlinkSchema,
  PROTOCOL_VERSION,
  RULE_SCHEMA_VERSION,
  type Uplink,
  type UplinkBody,
} from '../schema/message';
import { loadSettings, type Settings } from '../shared/settings';
import { getItem, setItem, sleep, uuid } from '../shared/storage';
import { getAccessToken } from './auth';
import { enqueue, flush } from './queue';

export type Channel = 'websocket' | 'sse' | 'poll';

export type TransportStatus =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'connected'; channel: Channel }
  | { status: 'error'; error: string };

type SyncMessage = Extract<Downlink, { kind: 'snapshot' | 'ruleUpsert' | 'ruleRemove' }>;

export interface TransportDeps {
  /** 应用一条带序号的下行消息 */
  apply(msg: SyncMessage): Promise<ApplyResult>;
  /** 当前本地序号，用于 hello 与增量拉取 */
  lastSeq(): Promise<number>;
  onStatus(status: TransportStatus): void;
}

interface Session {
  send(msg: Uplink): Promise<void>;
  close(): void;
  /** 会话结束时 resolve；stop 为 true 表示不应再重连 */
  closed: Promise<{ stop?: boolean; reauth?: boolean }>;
}

class Forbidden extends Error {}
class Unauthorized extends Error {}

const HEARTBEAT_MS = 20_000;
const DEAD_AFTER_MS = 50_000;
const POLL_ALARM = 'pagepilot-poll';
const CLIENT_ID_KEY = 'clientId';

const isTransient = (kind: Uplink['kind']) =>
  kind === 'hello' || kind === 'ack' || kind === 'resync' || kind === 'ping' || kind === 'pong';

async function clientId(): Promise<string> {
  const existing = await getItem<string | null>('local', CLIENT_ID_KEY, null);
  if (existing) return existing;
  const id = uuid();
  await setItem('local', CLIENT_ID_KEY, id);
  return id;
}

function channelOrder(pref: Settings['transport']): Channel[] {
  if (pref === 'websocket') return ['websocket', 'sse', 'poll'];
  if (pref === 'sse') return ['sse', 'poll'];
  return ['poll'];
}

export class Transport {
  private running = false;
  private session: Session | null = null;
  private awaitingSnapshot = false;
  private wake: (() => void) | null = null;

  constructor(private deps: TransportDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.run().finally(() => {
      this.running = false;
    });
  }

  stop(): void {
    this.running = false;
    this.session?.close();
    this.wake?.();
    void browser.alarms.clear(POLL_ALARM);
    this.deps.onStatus({ status: 'idle' });
  }

  /** 设置变化后重新连接 */
  restart(): void {
    this.session?.close();
    this.wake?.();
    if (!this.running) this.start();
  }

  /** 发送上行消息；业务类消息先入本地队列，连接可用时立即发送 */
  async send(body: UplinkBody): Promise<void> {
    const msg = { v: PROTOCOL_VERSION, id: uuid(), ...body } as Uplink;
    if (isTransient(msg.kind)) {
      await this.session?.send(msg).catch(() => undefined);
      return;
    }
    await enqueue(msg);
    const session = this.session;
    if (session) await flush((m) => session.send(m));
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      // 续期遇到网络错误或服务端故障时保留登录态，退避后重试；返回 null 才是需要重新登录
      let token: Awaited<ReturnType<typeof getAccessToken>>;
      try {
        token = await getAccessToken();
      } catch (e) {
        failures++;
        this.deps.onStatus({ status: 'error', error: e instanceof Error ? e.message : '续期失败' });
        await this.sleepOrWake(Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)));
        continue;
      }
      if (!token) {
        this.deps.onStatus({ status: 'idle' });
        return;
      }
      const settings = await loadSettings();
      if (!settings.backendUrl) {
        this.deps.onStatus({ status: 'error', error: '未配置后台地址' });
        return;
      }
      this.deps.onStatus({ status: 'connecting' });

      let established = false;
      let result: Awaited<Session['closed']> = {};
      let lastError = '连接失败';
      for (const channel of channelOrder(settings.transport)) {
        try {
          const session = await this.open(channel, settings, token.token);
          this.session = session;
          established = true;
          failures = 0;
          this.deps.onStatus({ status: 'connected', channel });
          await this.afterConnect(session, channel);
          result = await session.closed;
          this.session = null;
          break;
        } catch (e) {
          this.session = null;
          if (e instanceof Forbidden) {
            this.deps.onStatus({ status: 'error', error: '当前账号无权使用扩展' });
            return;
          }
          if (e instanceof Unauthorized) {
            result = { reauth: true };
            established = true;
            break;
          }
          lastError = e instanceof Error ? e.message : String(e);
        }
      }
      if (!this.running) return;
      if (result.stop) {
        this.deps.onStatus({ status: 'error', error: '后台拒绝了连接' });
        return;
      }
      if (result.reauth) {
        const fresh = await getAccessToken(true).catch(() => undefined);
        if (fresh === undefined) {
          failures++;
          await this.sleepOrWake(Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)));
          continue;
        }
        if (!fresh) {
          this.deps.onStatus({ status: 'idle' });
          return;
        }
        continue;
      }
      if (!established) {
        failures++;
        this.deps.onStatus({ status: 'error', error: lastError });
      }
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)) * (0.5 + Math.random() / 2);
      await this.sleepOrWake(established ? 1000 : delay);
    }
  }

  private sleepOrWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      this.wake = done;
      function done() {
        clearTimeout(t);
        resolve();
      }
    });
  }

  private async afterConnect(session: Session, channel: Channel): Promise<void> {
    if (channel !== 'poll') {
      await session.send({
        v: PROTOCOL_VERSION,
        id: uuid(),
        kind: 'hello',
        clientId: await clientId(),
        extVersion: browser.runtime.getManifest().version,
        ruleSchemaVersion: RULE_SCHEMA_VERSION,
        lastSeq: await this.deps.lastSeq(),
      });
    }
    await flush((m) => session.send(m));
  }

  private open(channel: Channel, settings: Settings, token: string): Promise<Session> {
    const base = (settings.backendUrl ?? '').replace(/\/+$/, '');
    if (channel === 'websocket') return this.openWs(base, token);
    if (channel === 'sse') return this.openSse(base, token);
    return this.openPoll(base, token, settings.pollIntervalSec);
  }

  /** 处理一条原始下行消息 */
  private async handle(raw: string, reply: (msg: Uplink) => Promise<void>): Promise<void> {
    let parsed: Downlink;
    try {
      const res = downlinkSchema.safeParse(JSON.parse(raw));
      if (!res.success) {
        console.warn('[pagepilot] 忽略无法识别的下行消息');
        return;
      }
      parsed = res.data;
    } catch {
      return;
    }
    const envelope = { v: PROTOCOL_VERSION } as const;
    switch (parsed.kind) {
      case 'ping':
        await reply({ ...envelope, id: uuid(), kind: 'pong' });
        return;
      case 'pong':
        return;
      case 'error':
        this.deps.onStatus({ status: 'error', error: parsed.message ?? parsed.code });
        return;
      default: {
        if (this.awaitingSnapshot && parsed.kind !== 'snapshot') return;
        const result = await this.deps.apply(parsed);
        if (result.type === 'gap') {
          this.awaitingSnapshot = true;
          await reply({ ...envelope, id: uuid(), kind: 'resync' });
          return;
        }
        if (parsed.kind === 'snapshot') this.awaitingSnapshot = false;
        await reply({ ...envelope, id: uuid(), kind: 'ack', seq: parsed.seq });
      }
    }
  }

  private async post(base: string, token: string, msg: Uplink): Promise<void> {
    const res = await fetch(`${base}/api/ext/uplink`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    if (res.status === 401) throw new Unauthorized();
    if (res.status === 403) throw new Forbidden();
    if (!res.ok) throw new Error(`上行失败 ${res.status}`);
  }

  private async openWs(base: string, token: string): Promise<Session> {
    const ticketRes = await fetch(`${base}/api/ext/ws-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (ticketRes.status === 401) throw new Unauthorized();
    if (ticketRes.status === 403) throw new Forbidden();
    if (!ticketRes.ok) throw new Error(`获取连接票据失败 ${ticketRes.status}`);
    const { ticket } = (await ticketRes.json()) as { ticket: string };

    const wsUrl = `${base.replace(/^http/, 'ws')}/api/ext/ws?ticket=${encodeURIComponent(ticket)}`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('WebSocket 连接失败'));
    });

    let lastSeen = Date.now();
    const send = async (msg: Uplink) => {
      if (ws.readyState !== WebSocket.OPEN) throw new Error('连接已关闭');
      ws.send(JSON.stringify(msg));
    };
    const heartbeat = setInterval(() => {
      if (Date.now() - lastSeen > DEAD_AFTER_MS) {
        ws.close();
        return;
      }
      void send({ v: PROTOCOL_VERSION, id: uuid(), kind: 'ping' }).catch(() => undefined);
    }, HEARTBEAT_MS);

    const closed = new Promise<{ stop?: boolean; reauth?: boolean }>((resolve) => {
      ws.onclose = (ev) => {
        clearInterval(heartbeat);
        if (ev.code === 4401) resolve({ reauth: true });
        else if (ev.code === 4403) resolve({ stop: true });
        else resolve({});
      };
    });
    ws.onmessage = (ev) => {
      lastSeen = Date.now();
      if (typeof ev.data === 'string') void this.handle(ev.data, send);
    };
    return { send, close: () => ws.close(), closed };
  }

  private async openSse(base: string, token: string): Promise<Session> {
    const since = await this.deps.lastSeq();
    const controller = new AbortController();
    const res = await fetch(`${base}/api/ext/stream?since=${since}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (res.status === 401) throw new Unauthorized();
    if (res.status === 403) throw new Forbidden();
    if (!res.ok || !res.body) throw new Error(`SSE 连接失败 ${res.status}`);

    const send = (msg: Uplink) => this.post(base, token, msg);
    const closed = (async () => {
      const reader = res.body?.getReader();
      if (!reader) return {};
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx = buffer.indexOf('\n\n');
          while (idx >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const data = block
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (data) await this.handle(data, send);
            idx = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // 断线或主动关闭
      }
      return {};
    })();
    return { send, close: () => controller.abort(), closed };
  }

  private async openPoll(base: string, token: string, intervalSec: number): Promise<Session> {
    const send = (msg: Uplink) => this.post(base, token, msg);
    const pollOnce = async (): Promise<void> => {
      const since = await this.deps.lastSeq();
      const res = await fetch(`${base}/api/ext/poll?since=${since}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) throw new Unauthorized();
      if (res.status === 403) throw new Forbidden();
      if (!res.ok) throw new Error(`轮询失败 ${res.status}`);
      const body = (await res.json()) as { messages?: unknown[] };
      for (const m of body.messages ?? []) await this.handle(JSON.stringify(m), send);
    };
    await pollOnce(); // 首次失败视为该通道不可用

    let stopped = false;
    let resolveClosed: (v: { reauth?: boolean }) => void = () => undefined;
    const closed = new Promise<{ reauth?: boolean }>((r) => {
      resolveClosed = r;
    });
    void browser.alarms.create(POLL_ALARM, { periodInMinutes: Math.max(0.5, intervalSec / 60) });
    void (async () => {
      while (!stopped) {
        await sleep(intervalSec * 1000);
        if (stopped) break;
        try {
          await pollOnce();
        } catch (e) {
          if (e instanceof Unauthorized) resolveClosed({ reauth: true });
          else resolveClosed({});
          return;
        }
      }
    })();
    return {
      send,
      close: () => {
        stopped = true;
        resolveClosed({});
      },
      closed,
    };
  }
}

export { POLL_ALARM };
