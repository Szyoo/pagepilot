import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Uplink } from '../../../src/schema/message';
import { resetFakeBrowser } from '../../helpers/fake-browser';

vi.mock('wxt/browser', async () => (await import('../../helpers/fake-browser')).browserModule);

const queue = await import('../../../src/transport/queue');

const msg = (id: string): Uplink => ({ v: 1, id, kind: 'resync' });
const ids = async () => (await queue.peekAll()).map((m) => m.id);

beforeEach(() => resetFakeBrowser());

describe('上行队列', () => {
  it('按入队顺序保存', async () => {
    await queue.enqueue(msg('a'));
    await queue.enqueue(msg('b'));
    await queue.enqueue(msg('c'));
    expect(await ids()).toEqual(['a', 'b', 'c']);
  });

  it('并发入队不会丢消息', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map((i) => queue.enqueue(msg(i))));
    expect((await ids()).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('超过 500 条时丢弃最旧的', async () => {
    for (let i = 0; i < 503; i++) await queue.enqueue(msg(`m${i}`));
    const all = await ids();
    expect(all).toHaveLength(500);
    expect(all[0]).toBe('m3');
    expect(all.at(-1)).toBe('m502');
  });

  it('remove 只删除指定 id', async () => {
    await queue.enqueue(msg('a'));
    await queue.enqueue(msg('b'));
    await queue.remove('a');
    expect(await ids()).toEqual(['b']);
  });

  it('flush 全部成功后队列清空，且按顺序发送', async () => {
    await queue.enqueue(msg('a'));
    await queue.enqueue(msg('b'));
    const sent: string[] = [];
    await queue.flush(async (m) => {
      sent.push(m.id);
    });
    expect(sent).toEqual(['a', 'b']);
    expect(await ids()).toEqual([]);
  });

  it('flush 遇到失败即停止，保留失败及其后的消息', async () => {
    for (const i of ['a', 'b', 'c', 'd']) await queue.enqueue(msg(i));
    const sent: string[] = [];
    await queue.flush(async (m) => {
      if (m.id === 'c') throw new Error('offline');
      sent.push(m.id);
    });
    expect(sent).toEqual(['a', 'b']);
    expect(await ids()).toEqual(['c', 'd']);
  });

  it('队列为空时 flush 不调用发送函数', async () => {
    const send = vi.fn();
    await queue.flush(send);
    expect(send).not.toHaveBeenCalled();
  });
});
