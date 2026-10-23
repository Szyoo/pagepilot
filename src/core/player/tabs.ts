import { browser } from 'wxt/browser';
import type { Locator } from '../../schema/rule';
import {
  CONTENT_MESSAGE,
  type ContentCommand,
  type PingResult,
  type ProbeResult,
} from '../../shared/content-api';
import { sleep } from '../../shared/storage';

const CONTENT_FILE = '/page-agent.js';

export async function sendTo<T>(tabId: number, command: ContentCommand, frameId = 0): Promise<T> {
  return (await browser.tabs.sendMessage(
    tabId,
    { type: CONTENT_MESSAGE, command },
    { frameId },
  )) as T;
}

/** 确保标签页里的 content script 已就绪，缺失时主动注入 */
export async function ensureContent(tabId: number): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await sendTo<PingResult | undefined>(tabId, { cmd: 'ping' });
      if (res?.ready) return;
    } catch {
      try {
        await browser.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: [CONTENT_FILE],
        });
      } catch {
        // 没有该页面的主机权限或页面尚未可注入，稍后重试
      }
    }
    await sleep(300);
  }
  throw new Error('无法在页面中注入脚本');
}

/** 发送命令；接收端不存在时尝试注入后重试 */
export async function command<T>(tabId: number, cmd: ContentCommand, frameId = 0): Promise<T> {
  try {
    return await sendTo<T>(tabId, cmd, frameId);
  } catch {
    await ensureContent(tabId);
    return sendTo<T>(tabId, cmd, frameId);
  }
}

export interface FrameInfo {
  frameId: number;
  parentFrameId: number;
  url: string;
}

export async function listFrames(tabId: number): Promise<FrameInfo[]> {
  const frames = await browser.webNavigation.getAllFrames({ tabId });
  return (frames ?? []).map((f) => ({
    frameId: f.frameId,
    parentFrameId: f.parentFrameId,
    url: f.url,
  }));
}

export interface Located {
  frameId: number;
  ignoreFrame: boolean;
  /** 目标所在 frame 的 URL，用于校验凭据可用域名 */
  url: string;
}

/** 找到定位器命中的 frame：优先主 frame，经过跨域 iframe 时逐个子 frame 尝试 */
export async function locate(tabId: number, locator: Locator): Promise<Located | null> {
  const top = await command<ProbeResult>(tabId, { cmd: 'probe', locator });
  const topUrl = (await command<PingResult>(tabId, { cmd: 'ping' })).url;
  if (top.status === 'ok') {
    return top.count === 1 ? { frameId: 0, ignoreFrame: false, url: topUrl } : null;
  }
  for (const f of await listFrames(tabId)) {
    if (f.frameId === 0) continue;
    try {
      const r = await sendTo<ProbeResult>(
        tabId,
        { cmd: 'probe', locator, ignoreFrame: true },
        f.frameId,
      );
      if (r.count === 1) return { frameId: f.frameId, ignoreFrame: true, url: f.url };
    } catch {
      // 该 frame 没有 content script
    }
  }
  return null;
}

/** 子 frame 视口坐标 -> 顶层视口坐标 */
export async function toTopViewport(
  tabId: number,
  frameId: number,
  point: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  if (frameId === 0) return point;
  const frames = await listFrames(tabId);
  let x = point.x;
  let y = point.y;
  let cur = frames.find((f) => f.frameId === frameId);
  while (cur && cur.frameId !== 0) {
    const parent = frames.find((f) => f.frameId === cur?.parentFrameId);
    if (!parent) break;
    const off = await sendTo<{ x: number; y: number } | null>(
      tabId,
      { cmd: 'frameOffset', url: cur.url },
      parent.frameId,
    );
    if (off) {
      x += off.x;
      y += off.y;
    }
    cur = parent;
  }
  return { x, y };
}
