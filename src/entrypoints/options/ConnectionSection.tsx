import { type FormEvent, useState } from 'react';
import type { BgState } from '../../shared/rpc';
import { rpc } from '../../shared/rpc';
import { type Settings, saveSettings } from '../../shared/settings';
import { Badge, Button, ErrorText, Field, inputClass } from '../../shared/ui/components';
import { useAction } from '../../shared/ui/useAction';
import { SaveBar } from './SaveBar';
import { Section } from './Section';

export function ConnectionSection({ settings, bg }: { settings: Settings; bg: BgState | null }) {
  const [backendUrl, setBackendUrl] = useState(settings.backendUrl ?? '');
  const [authUrl, setAuthUrl] = useState(settings.authUrl ?? '');
  const [clientId, setClientId] = useState(settings.clientId);
  const [transport, setTransport] = useState(settings.transport);
  const [poll, setPoll] = useState(String(settings.pollIntervalSec));
  const [saved, setSaved] = useState(false);
  const save = useAction();
  const auth = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const ok = await save.run(async () => {
      const patch: Partial<Settings> = {
        clientId: clientId.trim() || 'pagepilot',
        transport,
        pollIntervalSec: Number(poll),
      };
      const b = backendUrl.trim();
      const a = authUrl.trim();
      if (b) patch.backendUrl = b;
      if (a) patch.authUrl = a;
      // 清空时需要移除旧值：saveSettings 会与旧设置合并，因此显式置空
      const next = { ...patch } as Record<string, unknown>;
      if (!b) next.backendUrl = undefined;
      if (!a) next.authUrl = undefined;
      await saveSettings(next as Partial<Settings>);
      return true;
    });
    if (ok) setSaved(true);
  };

  const signedIn = bg?.auth.status === 'signedIn';

  return (
    <Section title="连接" description="后台与授权服务的地址，以及实时通道方式。">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-slate-700">账号状态</span>
        {bg ? (
          <Badge tone={signedIn ? 'green' : 'gray'}>{signedIn ? '已登录' : '未登录'}</Badge>
        ) : (
          <span className="text-sm text-slate-500">加载中…</span>
        )}
        {signedIn ? (
          <Button disabled={auth.busy} onClick={() => void auth.run(() => rpc('auth.logout'))}>
            登出
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={auth.busy || !bg}
            onClick={() => void auth.run(() => rpc('auth.login'))}
          >
            {auth.busy ? '登录中…' : '登录'}
          </Button>
        )}
        <ErrorText>{auth.error}</ErrorText>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <Field label="后台地址" hint="例如 https://api.example.com">
          {(id) => (
            <input
              id={id}
              type="url"
              className={inputClass}
              value={backendUrl}
              onChange={(e) => setBackendUrl(e.target.value)}
            />
          )}
        </Field>
        <Field label="授权服务地址" hint="留空表示与后台地址相同">
          {(id) => (
            <input
              id={id}
              type="url"
              className={inputClass}
              value={authUrl}
              onChange={(e) => setAuthUrl(e.target.value)}
            />
          )}
        </Field>
        <Field label="Client ID">
          {(id) => (
            <input
              id={id}
              className={inputClass}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          )}
        </Field>
        <Field label="实时通道">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={transport}
              onChange={(e) => setTransport(e.target.value as Settings['transport'])}
            >
              <option value="websocket">WebSocket</option>
              <option value="sse">SSE</option>
              <option value="poll">轮询</option>
            </select>
          )}
        </Field>
        <Field label="轮询间隔（秒）" hint="至少 30 秒，仅轮询方式使用">
          {(id) => (
            <input
              id={id}
              type="number"
              min={30}
              step={1}
              className={inputClass}
              value={poll}
              onChange={(e) => setPoll(e.target.value)}
              required
            />
          )}
        </Field>
        <SaveBar busy={save.busy} error={save.error} saved={saved} />
      </form>
    </Section>
  );
}
