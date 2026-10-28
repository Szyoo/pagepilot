import { type FormEvent, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { BridgeInfo } from '../../shared/bridge-discovery';
import type { BgState } from '../../shared/rpc';
import { rpc } from '../../shared/rpc';
import { type Settings, saveSettings } from '../../shared/settings';
import { Badge, Button, ErrorText, Field, inputClass } from '../../shared/ui/components';
import { useAction } from '../../shared/ui/useAction';
import { SaveBar } from './SaveBar';
import { Section } from './Section';

// 构建期默认地址（来自本机 .env）；已配置时界面默认不显示地址输入
const ENV_BACKEND = (import.meta.env.VITE_DEFAULT_BACKEND_URL as string | undefined) || '';
const ENV_PORTAL = (import.meta.env.VITE_DEFAULT_PORTAL_URL as string | undefined) || '';

const BRIDGE_SOURCE: Record<string, string> = {
  settings: '手动设置',
  backend: '来自后台',
  build: '构建默认值',
};

export function ConnectionSection({ settings, bg }: { settings: Settings; bg: BgState | null }) {
  const [backendUrl, setBackendUrl] = useState(settings.backendUrl ?? '');
  const [portalUrl, setPortalUrl] = useState(settings.portalUrl ?? '');
  const [bridgeUrl, setBridgeUrl] = useState(settings.bridgeUrl ?? '');
  const [transport, setTransport] = useState(settings.transport);
  const [poll, setPoll] = useState(String(settings.pollIntervalSec));
  const [username, setUsername] = useState('');
  // 密码只存在于输入框的组件状态中：不写入任何存储、不打印，登录后清空
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const [bridge, setBridge] = useState<BridgeInfo | null>(null);
  const save = useAction();
  const auth = useAction();

  // 当前生效的 AI 服务地址与来源；登录状态变化后重新查询
  const authStatus = bg?.auth.status;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 登录状态变化时需要重新查询
  useEffect(() => {
    let alive = true;
    rpc('ai.bridge')
      .then((b) => alive && setBridge(b))
      .catch(() => alive && setBridge(null));
    return () => {
      alive = false;
    };
  }, [authStatus]);

  const persist = async () => {
    const patch: Partial<Settings> = { transport, pollIntervalSec: Number(poll) };
    const b = backendUrl.trim();
    const p = portalUrl.trim();
    const a = bridgeUrl.trim();
    // 与构建期默认地址相同的值不保存，这样重新构建时新的默认地址能生效
    if (b && b !== ENV_BACKEND) patch.backendUrl = b;
    if (p && p !== ENV_PORTAL) patch.portalUrl = p;
    if (a) patch.bridgeUrl = a;
    // 清空或恢复默认时需要移除旧值：saveSettings 会与旧设置合并，因此显式置空
    const next = { ...patch } as Record<string, unknown>;
    if (!b || b === ENV_BACKEND) next.backendUrl = undefined;
    if (!p || p === ENV_PORTAL) next.portalUrl = undefined;
    if (!a) next.bridgeUrl = undefined;
    await saveSettings(next as Partial<Settings>);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const ok = await save.run(async () => {
      await persist();
      return true;
    });
    if (ok) setSaved(true);
  };

  const login = (e: FormEvent) => {
    e.preventDefault();
    const name = username.trim();
    const pass = password;
    // permissions.request 需要用户手势，必须由点击/提交处理函数发起，因此先保存设置再申请
    void auth.run(async () => {
      await persist();
      const origins = await rpc('auth.origins');
      const granted = await browser.permissions.request({ origins });
      if (!granted) throw new Error('需要授予门户与后台的网站访问权限才能登录');
      await rpc('auth.login', { username: name, password: pass });
      setPassword('');
    });
  };

  const signedIn = bg?.auth.status === 'signedIn';

  return (
    <Section title="连接" description="门户与后台的地址、账号登录，以及实时通道方式。">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-700">账号状态</span>
          {bg ? (
            <Badge tone={signedIn ? 'green' : 'gray'}>{signedIn ? '已登录' : '未登录'}</Badge>
          ) : (
            <span className="text-sm text-slate-500">加载中…</span>
          )}
          {signedIn ? (
            <>
              {bg?.auth.userId ? (
                <span className="text-sm text-slate-700">用户：{bg.auth.userId}</span>
              ) : null}
              <Button disabled={auth.busy} onClick={() => void auth.run(() => rpc('auth.logout'))}>
                登出
              </Button>
            </>
          ) : null}
        </div>
        <p className="text-xs text-slate-500">
          使用门户账号登录。会话过期后需要重新登录；密码不会被保存。登录使用已保存的地址，点击「登录」会先保存下方的连接设置，并请求门户与后台的网站访问权限。
        </p>
        {signedIn ? null : (
          <form onSubmit={login} className="space-y-3">
            <Field label="账号">
              {(id) => (
                <input
                  id={id}
                  className={inputClass}
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              )}
            </Field>
            <Field label="密码">
              {(id) => (
                <input
                  id={id}
                  type="password"
                  className={inputClass}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              )}
            </Field>
            <Button type="submit" variant="primary" disabled={auth.busy || !bg}>
              {auth.busy ? '登录中…' : '登录'}
            </Button>
          </form>
        )}
        <ErrorText>{auth.error}</ErrorText>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <details open={!ENV_BACKEND} className="rounded border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm text-slate-700">
            {ENV_BACKEND
              ? '高级：门户、后台与 AI 服务地址（已有构建默认值）'
              : '门户、后台与 AI 服务地址'}
          </summary>
          <div className="mt-3 space-y-4">
            <Field label="门户地址" hint="登录接口所在地址，留空表示与后台地址相同">
              {(id) => (
                <input
                  id={id}
                  type="url"
                  className={inputClass}
                  value={portalUrl}
                  onChange={(e) => setPortalUrl(e.target.value)}
                  placeholder="https://portal.example.com"
                />
              )}
            </Field>
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
            <Field
              label="AI 服务地址"
              hint={`一般留空：扩展会从后台自动获取。需要覆盖时填 claude-bridge 的浏览器接口，例如 https://bridge.example.com/api。${
                bridge?.bridgeUrl
                  ? `当前生效：${bridge.bridgeUrl}（${BRIDGE_SOURCE[bridge.source ?? ''] ?? '未知来源'}）`
                  : '当前没有可用的地址。'
              }`}
            >
              {(id) => (
                <input
                  id={id}
                  type="url"
                  className={inputClass}
                  value={bridgeUrl}
                  onChange={(e) => setBridgeUrl(e.target.value)}
                />
              )}
            </Field>
          </div>
        </details>
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
