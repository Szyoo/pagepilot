import { browser } from 'wxt/browser';
import { captureElements } from '../core/capture';
import { frameOffsetByUrl, performAct, prepareTarget } from '../core/player/actions';
import { detectCaptcha } from '../core/player/captcha';
import { createRecorder } from '../core/recorder';
import { isVisible, resolve } from '../core/selector';
import { evaluateCondition } from '../core/selector/condition';
import {
  type CaptureResult,
  CONTENT_MESSAGE,
  type ContentCommand,
  type ContentEvent,
  EVENT_MESSAGE,
  type PingResult,
  type ProbeResult,
} from '../shared/content-api';

declare global {
  interface Window {
    __pagepilot?: boolean;
  }
}

// 不声明 matches：网站访问权限由用户按规则逐个授予，授权后由后台动态注册或主动注入
export default defineUnlistedScript(() => {
  {
    if (window.__pagepilot) return; // 同一 frame 可能被重复注入
    window.__pagepilot = true;

    const send = (event: ContentEvent) =>
      void browser.runtime.sendMessage({ type: EVENT_MESSAGE, ...event }).catch(() => undefined);

    let lastMutation = Date.now();
    new MutationObserver(() => {
      lastMutation = Date.now();
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

    const recorder = createRecorder((record) =>
      send({ event: 'recorded', record, url: location.href }),
    );

    function handle(cmd: ContentCommand): unknown {
      switch (cmd.cmd) {
        case 'ping':
          return {
            ready: true,
            isTop: window === window.top,
            url: location.href,
          } satisfies PingResult;
        case 'probe': {
          const r = resolve(cmd.locator, cmd.ignoreFrame ?? false);
          const el = r.element;
          return {
            status: r.crossOrigin ? 'crossOrigin' : 'ok',
            count: r.count,
            visible: el ? isVisible(el) : false,
            text: el ? ((el as HTMLElement).innerText ?? el.textContent ?? '').slice(0, 200) : '',
          } satisfies ProbeResult;
        }
        case 'condition':
          return { result: evaluateCondition(cmd.condition) };
        case 'act':
          return performAct(cmd.act, cmd.locator, cmd.ignoreFrame ?? false);
        case 'prepare':
          return prepareTarget(
            cmd.locator,
            cmd.ignoreFrame ?? false,
            cmd.focus ?? false,
            cmd.selectContent ?? false,
          );
        case 'frameOffset':
          return frameOffsetByUrl(cmd.url);
        case 'captcha':
          return { found: detectCaptcha() };
        case 'idle':
          return { idle: document.readyState === 'complete' && Date.now() - lastMutation > 500 };
        case 'capture':
          return { elements: captureElements(), title: document.title } satisfies CaptureResult;
        case 'recorder':
          if (cmd.on) recorder.start();
          else recorder.stop();
          return { ok: true };
      }
    }

    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      const m = msg as { type?: string; command?: ContentCommand } | null;
      if (m?.type !== CONTENT_MESSAGE || !m.command) return undefined;
      try {
        sendResponse(handle(m.command));
      } catch (e) {
        sendResponse({
          ok: false,
          code: 'INTERNAL',
          message: e instanceof Error ? e.message : String(e),
        });
      }
      return undefined;
    });

    send({ event: 'loaded', url: location.href, isTop: window === window.top });
  }
});
