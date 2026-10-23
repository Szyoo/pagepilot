import { browser } from 'wxt/browser';

/** 系统通知；提示音需要调用方先确认设置页的声音开关已打开 */
export function notify(title: string, message: string, sound: boolean): void {
  void browser.notifications
    .create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title,
      message,
    })
    .catch(() => undefined);
  if (sound) void beep();
}

async function beep(): Promise<void> {
  try {
    const url = browser.runtime.getURL('/offscreen.html');
    const existing = await browser.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    });
    if (existing.length === 0) {
      await browser.offscreen.createDocument({
        url: '/offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: '条件满足时播放提示音',
      });
    }
    await browser.runtime.sendMessage({ type: 'offscreen.beep' });
  } catch {
    // 声音不是关键路径
  }
}
