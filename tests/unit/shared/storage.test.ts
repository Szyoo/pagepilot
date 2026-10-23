import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFakeBrowser } from '../../helpers/fake-browser';

vi.mock('wxt/browser', async () => (await import('../../helpers/fake-browser')).browserModule);

const { getItem, removeItem, setItem, sleep, uuid } = await import('../../../src/shared/storage');

beforeEach(() => resetFakeBrowser());

describe('storage 封装', () => {
  it('缺失时返回 fallback', async () => {
    expect(await getItem('local', 'k', 'dflt')).toBe('dflt');
  });

  it('写入后可读，local 与 session 互不影响', async () => {
    await setItem('local', 'k', { a: 1 });
    expect(await getItem('local', 'k', null)).toEqual({ a: 1 });
    expect(await getItem('session', 'k', null)).toBeNull();
  });

  it('removeItem 删除后回到 fallback', async () => {
    await setItem('session', 'k', 1);
    await removeItem('session', 'k');
    expect(await getItem('session', 'k', 0)).toBe(0);
  });

  it('uuid 生成不同的 v4 标识', () => {
    const a = uuid();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(uuid()).not.toBe(a);
  });

  it('sleep 在计时器到期后完成', async () => {
    vi.useFakeTimers();
    let done = false;
    const p = sleep(1000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    vi.useRealTimers();
  });
});
