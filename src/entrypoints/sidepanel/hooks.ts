import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { loadSettings, SETTINGS_KEY } from '../../shared/settings';

export interface ActiveTab {
  id?: number | undefined;
  url?: string | undefined;
}

/** 当前窗口的活动标签页；切换、导航时更新，卸载时移除监听 */
export function useActiveTab(): ActiveTab | null {
  const [tab, setTab] = useState<ActiveTab | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      browser.tabs
        .query({ active: true, currentWindow: true })
        .then(([t]) => alive && setTab({ id: t?.id, url: t?.url }))
        .catch(() => alive && setTab({}));
    };
    const onUpdated = (
      _id: number,
      change: { url?: string; status?: string },
      t: { active?: boolean },
    ) => {
      if (t.active && (change.url !== undefined || change.status === 'complete')) refresh();
    };
    refresh();
    browser.tabs.onActivated.addListener(refresh);
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      alive = false;
      browser.tabs.onActivated.removeListener(refresh);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  return tab;
}

/** 设置里的后台地址（含构建期默认值），设置变化时更新 */
export function useBackendUrl(): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      loadSettings()
        .then((s) => alive && setUrl(s.backendUrl))
        .catch(() => undefined);
    };
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && SETTINGS_KEY in changes) refresh();
    };
    refresh();
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  return url;
}

/** 每秒更新的当前时间；enabled 为 false 时不开定时器 */
export function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}
