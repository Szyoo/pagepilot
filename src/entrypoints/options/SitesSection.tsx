import { type FormEvent, useState } from 'react';
import { type Settings, saveSettings } from '../../shared/settings';
import { Button, inputClass } from '../../shared/ui/components';
import { useAction } from '../../shared/ui/useAction';
import { SaveBar } from './SaveBar';
import { Section } from './Section';

type Mode = Settings['sites'][string]['inputMode'];
interface Row {
  key: number;
  host: string;
  inputMode: Mode;
}

export function SitesSection({ settings }: { settings: Settings }) {
  const [nextKey, setNextKey] = useState(Object.keys(settings.sites).length);
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(settings.sites).map(([host, v], key) => ({
      key,
      host,
      inputMode: v.inputMode,
    })),
  );
  const [saved, setSaved] = useState(false);
  const save = useAction();

  const update = (key: number, patch: Partial<Row>) => {
    setSaved(false);
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const ok = await save.run(async () => {
      const sites: Settings['sites'] = {};
      for (const r of rows) {
        const host = r.host.trim().toLowerCase();
        if (!host) continue;
        if (host in sites) throw new Error(`主机名重复：${host}`);
        sites[host] = { inputMode: r.inputMode };
      }
      await saveSettings({ sites });
      return true;
    });
    if (ok) setSaved(true);
  };

  return (
    <Section
      title="站点"
      description={
        <>
          按主机名覆盖输入方式，优先于规则自带的设置。「可信输入」需要「调试」权限，运行期间浏览器会显示调试提示条。
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        {rows.length === 0 ? <p className="text-sm text-slate-500">尚未设置任何站点。</p> : null}
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li key={r.key} className="flex items-center gap-2">
              <input
                aria-label={`第 ${i + 1} 行主机名`}
                placeholder="example.com"
                className={inputClass}
                value={r.host}
                onChange={(e) => update(r.key, { host: e.target.value })}
              />
              <select
                aria-label={`第 ${i + 1} 行输入方式`}
                className={`${inputClass} w-48 shrink-0`}
                value={r.inputMode}
                onChange={(e) => update(r.key, { inputMode: e.target.value as Mode })}
              >
                <option value="auto">自动选择</option>
                <option value="trusted">可信输入（调试）</option>
                <option value="synthetic">模拟输入</option>
              </select>
              <Button
                variant="ghost"
                className="shrink-0"
                aria-label={`删除第 ${i + 1} 行`}
                onClick={() => {
                  setSaved(false);
                  setRows((rs) => rs.filter((x) => x.key !== r.key));
                }}
              >
                删除
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3">
          <Button
            onClick={() => {
              setRows((rs) => [...rs, { key: nextKey, host: '', inputMode: 'auto' }]);
              setNextKey((k) => k + 1);
              setSaved(false);
            }}
          >
            添加站点
          </Button>
        </div>
        <SaveBar busy={save.busy} error={save.error} saved={saved} />
      </form>
    </Section>
  );
}
