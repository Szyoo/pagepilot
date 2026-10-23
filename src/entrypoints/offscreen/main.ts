import { browser } from 'wxt/browser';

/** 离屏文档：只负责播放提示音，由后台在用户开启声音开关时调用 */

browser.runtime.onMessage.addListener((msg) => {
  if ((msg as { type?: string } | null)?.type !== 'offscreen.beep') return undefined;
  const ctx = new AudioContext();
  const gain = ctx.createGain();
  gain.gain.value = 0.15;
  gain.connect(ctx.destination);
  for (const [i, freq] of [880, 1175].entries()) {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(ctx.currentTime + i * 0.25);
    osc.stop(ctx.currentTime + i * 0.25 + 0.2);
  }
  setTimeout(() => void ctx.close(), 800);
  return undefined;
});
