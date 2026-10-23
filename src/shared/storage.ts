import { browser } from 'wxt/browser';

type Area = 'local' | 'session';

export async function getItem<T>(area: Area, key: string, fallback: T): Promise<T> {
  const got = await browser.storage[area].get(key);
  return (got[key] as T | undefined) ?? fallback;
}

export async function setItem(area: Area, key: string, value: unknown): Promise<void> {
  await browser.storage[area].set({ [key]: value });
}

export async function removeItem(area: Area, key: string): Promise<void> {
  await browser.storage[area].remove(key);
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
