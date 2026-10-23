import type { Uplink } from '../schema/message';
import { getItem, setItem } from '../shared/storage';

/** 上行消息的本地队列：发送失败时保留，恢复连接后按顺序重发 */

/** 后台明确拒绝这条消息（格式错误、过大等）：重试没有意义，应丢弃而不是卡住队列 */
export class PermanentUplinkError extends Error {}

const KEY = 'uplinkQueue';
const MAX = 500;

let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
};

export function enqueue(msg: Uplink): Promise<void> {
  return serial(async () => {
    const q = await getItem<Uplink[]>('local', KEY, []);
    q.push(msg);
    await setItem('local', KEY, q.slice(-MAX));
  });
}

export function peekAll(): Promise<Uplink[]> {
  return getItem<Uplink[]>('local', KEY, []);
}

export function remove(id: string): Promise<void> {
  return serial(async () => {
    const q = await getItem<Uplink[]>('local', KEY, []);
    await setItem(
      'local',
      KEY,
      q.filter((m) => m.id !== id),
    );
  });
}

/** 依次发送，遇到失败即停止（保留未发送部分） */
export async function flush(send: (msg: Uplink) => Promise<void>): Promise<void> {
  for (const msg of await peekAll()) {
    try {
      await send(msg);
    } catch (e) {
      if (e instanceof PermanentUplinkError) {
        await remove(msg.id);
        continue;
      }
      return;
    }
    await remove(msg.id);
  }
}
