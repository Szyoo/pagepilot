import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { LocalData } from '../../schema/profile';
import { rpc } from '../../shared/rpc';
import { Button, ErrorText, Field, inputClass } from '../../shared/ui/components';
import { useAction } from '../../shared/ui/useAction';
import { Section } from './Section';

interface KV {
  key: number;
  name: string;
  value: string;
  origins: string;
}

function toRows(data: LocalData, kind: 'profile' | 'secret', start: number): KV[] {
  return Object.entries(data[kind]).map(([name, value], i) => ({
    key: start + i,
    name,
    value,
    origins: kind === 'secret' ? (data.secretOrigins[name] ?? []).join(', ') : '',
  }));
}

function RowsEditor({
  title,
  rows,
  setRows,
  secret,
  nextKey,
}: {
  title: string;
  rows: KV[];
  setRows: (fn: (rs: KV[]) => KV[]) => void;
  secret: boolean;
  nextKey: () => number;
}) {
  const patch = (key: number, p: Partial<KV>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-slate-800">{title}</legend>
      {rows.length === 0 ? <p className="text-sm text-slate-500">暂无条目。</p> : null}
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.key} className="space-y-1 rounded-md border border-slate-200 p-2">
            <div className="flex items-center gap-2">
              <input
                aria-label={`${title}第 ${i + 1} 项名称`}
                placeholder="名称"
                className={`${inputClass} w-1/3`}
                value={r.name}
                onChange={(e) => patch(r.key, { name: e.target.value })}
              />
              <input
                aria-label={`${title}第 ${i + 1} 项的值`}
                placeholder="值"
                type={secret ? 'password' : 'text'}
                autoComplete={secret ? 'new-password' : 'off'}
                className={inputClass}
                value={r.value}
                onChange={(e) => patch(r.key, { value: e.target.value })}
              />
              <Button
                variant="ghost"
                className="shrink-0"
                aria-label={`删除${title}第 ${i + 1} 项`}
                onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
              >
                删除
              </Button>
            </div>
            {secret ? (
              <input
                aria-label={`${title}第 ${i + 1} 项允许使用的域名`}
                placeholder="允许使用的域名，逗号分隔，如 example.com, *.example.com"
                className={inputClass}
                value={r.origins}
                onChange={(e) => patch(r.key, { origins: e.target.value })}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <Button
        onClick={() =>
          setRows((rs) => [...rs, { key: nextKey(), name: '', value: '', origins: '' }])
        }
      >
        添加
      </Button>
    </fieldset>
  );
}

function Editor() {
  const [profile, setProfile] = useState<KV[]>([]);
  const [secret, setSecret] = useState<KV[]>([]);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const counter = useRef(0);
  const nextKey = () => counter.current++;
  const load = useAction();
  const loadRun = load.run;
  const save = useAction();
  const exp = useAction();

  useEffect(() => {
    let alive = true;
    void loadRun(async () => {
      const data = await rpc('vault.get');
      if (!alive) return;
      const p = toRows(data, 'profile', counter.current);
      counter.current += p.length;
      const s = toRows(data, 'secret', counter.current);
      counter.current += s.length;
      setProfile(p);
      setSecret(s);
    }).finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [loadRun]);

  const noOrigins = secret.filter((r) => r.name.trim() && !r.origins.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const ok = await save.run(async () => {
      const data: LocalData = { profile: {}, secret: {}, secretOrigins: {} };
      for (const r of profile) {
        const name = r.name.trim();
        if (!name) continue;
        if (name in data.profile) throw new Error(`个人信息名称重复：${name}`);
        data.profile[name] = r.value;
      }
      for (const r of secret) {
        const name = r.name.trim();
        if (!name) continue;
        if (name in data.secret) throw new Error(`凭据名称重复：${name}`);
        data.secret[name] = r.value;
        data.secretOrigins[name] = r.origins
          .split(/[,，\s]+/)
          .map((o) => o.trim().toLowerCase())
          .filter(Boolean);
      }
      await rpc('vault.save', data);
      return true;
    });
    if (ok) setSaved(true);
  };

  const download = () =>
    void exp.run(async () => {
      const text = await rpc('vault.export');
      if (!window.confirm('备份是明文，请妥善保管。继续下载？')) return;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `pagepilot-vault-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

  if (loading) {
    return (
      <p role="status" className="text-sm text-slate-500">
        加载中…
      </p>
    );
  }
  if (load.error) return <ErrorText>{load.error}</ErrorText>;

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-4">
        <RowsEditor
          title="个人信息"
          rows={profile}
          setRows={(fn) => {
            setSaved(false);
            setProfile(fn);
          }}
          secret={false}
          nextKey={nextKey}
        />
        <RowsEditor
          title="凭据"
          rows={secret}
          setRows={(fn) => {
            setSaved(false);
            setSecret(fn);
          }}
          secret
          nextKey={nextKey}
        />
        {noOrigins.length > 0 ? (
          <p role="note" className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">
            没有配置允许域名的凭据将无法被使用：{noOrigins.map((r) => r.name.trim()).join('、')}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={save.busy}>
            {save.busy ? '保存中…' : '保存'}
          </Button>
          {saved && !save.error ? (
            <span role="status" className="text-sm text-green-700">
              已保存
            </span>
          ) : null}
          <ErrorText>{save.error}</ErrorText>
        </div>
      </form>
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
        <Button disabled={exp.busy} onClick={download}>
          导出
        </Button>
        <span className="text-xs text-slate-500">备份是明文，请妥善保管。</span>
      </div>
      <ErrorText>{exp.error}</ErrorText>
    </div>
  );
}

function ImportForm() {
  const [file, setFile] = useState<File | null>(null);
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setDone(false);
    const ok = await run(async () => {
      const backup = await file.text();
      await rpc('vault.import', { backup });
      return true;
    });
    if (ok) setDone(true);
  };

  return (
    <form onSubmit={submit} className="space-y-3 border-t border-slate-200 pt-4">
      <h3 className="text-sm font-semibold text-slate-800">导入备份</h3>
      <p className="text-xs text-slate-500">
        导入成功后将替换当前账号在本机的保险库数据。需要重新打开本页才能看到更新后的内容。
      </p>
      <Field label="备份文件">
        {(id) => (
          <input
            id={id}
            type="file"
            className="block w-full text-sm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        )}
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !file}>
          {busy ? '导入中…' : '导入'}
        </Button>
        {done && !error ? (
          <span role="status" className="text-sm text-green-700">
            已导入
          </span>
        ) : null}
        <ErrorText>{error}</ErrorText>
      </div>
    </form>
  );
}

export function VaultSection({ signedIn }: { signedIn: boolean | undefined }) {
  return (
    <Section
      title="本地数据保险库"
      description="个人信息与凭据只保存在本机浏览器，不会上报；数据按门户账号隔离。"
    >
      {signedIn === undefined ? (
        <p role="status" className="text-sm text-slate-500">
          加载中…
        </p>
      ) : !signedIn ? (
        <p role="status" className="text-sm text-slate-600">
          请先登录门户账号。
        </p>
      ) : (
        <>
          <Editor />
          <ImportForm />
        </>
      )}
    </Section>
  );
}
