import { browser } from 'wxt/browser';

/** 真实输入：通过 chrome.debugger + CDP 派发鼠标与键盘事件，页面看到的是 isTrusted 事件 */

const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  shift: 8,
};

export class TrustedInput {
  private attached = new Set<number>();

  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;
    try {
      await browser.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      // 已被本扩展附加时忽略
      if (!(e instanceof Error) || !/already attached/i.test(e.message)) throw e;
    }
    this.attached.add(tabId);
  }

  private async send(
    tabId: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.attach(tabId);
    await browser.debugger.sendCommand({ tabId }, method, params);
  }

  async click(tabId: number, x: number, y: number): Promise<void> {
    await this.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await this.send(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  async insertText(tabId: number, text: string): Promise<void> {
    if (!text) return;
    await this.send(tabId, 'Input.insertText', { text });
  }

  async key(tabId: number, combo: string): Promise<void> {
    const parts = combo.split('+');
    const main = parts.pop() ?? '';
    const modifiers = parts.reduce((m, p) => m | (MODIFIER_BITS[p.toLowerCase()] ?? 0), 0);
    const def = KEYS[main] ?? {
      key: main,
      code: main.length === 1 ? `Key${main.toUpperCase()}` : main,
      vk: main.length === 1 ? main.toUpperCase().charCodeAt(0) : 0,
      ...(main.length === 1 ? { text: main } : {}),
    };
    const typed = modifiers & ~8 ? undefined : def.text; // Ctrl/Alt/Meta 组合不产生文本
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: typed ? 'keyDown' : 'rawKeyDown',
      modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      ...(typed ? { text: typed } : {}),
    });
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
    });
  }

  /** 释放所有调试连接，去掉浏览器的调试提示条 */
  async detachAll(): Promise<void> {
    for (const tabId of this.attached) {
      await browser.debugger.detach({ tabId }).catch(() => undefined);
    }
    this.attached.clear();
  }
}
