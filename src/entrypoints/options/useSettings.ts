import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { loadSettings, SETTINGS_KEY, type Settings } from '../../shared/settings';

/** 读取设置，并在设置在别处被修改时同步 */
export function useSettings(): { settings: Settings | null; error: string | null } {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      loadSettings()
        .then(setSettings)
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void load();
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && SETTINGS_KEY in changes) void load();
    };
    browser.storage.onChanged.addListener(listener as never);
    return () => browser.storage.onChanged.removeListener(listener as never);
  }, []);

  return { settings, error };
}
