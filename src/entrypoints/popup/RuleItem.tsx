import { browser } from 'wxt/browser';
import { originPatternOf } from '../../shared/glob';
import { type RuleView, rpc } from '../../shared/rpc';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  INPUT_MODE_LABEL,
  TRIGGER_LABEL,
} from '../../shared/ui/components';
import { useAction } from '../../shared/ui/useAction';

function requiresText(rule: RuleView): string {
  const parts: string[] = [];
  if (rule.requires.profile.length) parts.push(`个人信息：${rule.requires.profile.join('、')}`);
  if (rule.requires.secret.length) parts.push(`凭据：${rule.requires.secret.join('、')}`);
  return parts.join('；') || '无';
}

export function RuleItem({ rule, tabId }: { rule: RuleView; tabId: number | undefined }) {
  const { busy, error, run } = useAction();

  const start = () => {
    if (tabId === undefined) return;
    // 权限申请必须在点击处理函数中直接发起（用户手势）；合并为一次请求
    const origins = [
      ...new Set(rule.matchUrls.map(originPatternOf).filter((o): o is string => o !== null)),
    ];
    const request: { origins: string[]; permissions?: string[] } = { origins };
    if (rule.inputMode === 'trusted') request.permissions = ['debugger'];
    void run(async () => {
      const granted = await browser.permissions.request(request as never);
      if (!granted) throw new Error('未授予所需权限，无法运行');
      await rpc('run.start', { ruleId: rule.id, tabId });
    });
  };

  const approve = () => void run(() => rpc('rule.approve', { ruleId: rule.id }));
  const setAuto = (enabled: boolean) =>
    void run(() => rpc('rule.setAuto', { ruleId: rule.id, enabled }));

  return (
    <Card className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{rule.name}</p>
          <p className="text-xs text-slate-500">版本 {rule.version}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Badge tone={rule.trigger === 'auto' ? 'blue' : 'gray'}>
            {TRIGGER_LABEL[rule.trigger]}
          </Badge>
          {!rule.enabled ? <Badge tone="amber">已停用</Badge> : null}
        </div>
      </div>
      <dl className="space-y-0.5 text-xs text-slate-600">
        <div className="flex gap-1">
          <dt className="shrink-0 text-slate-500">输入方式</dt>
          <dd>{INPUT_MODE_LABEL[rule.inputMode]}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="shrink-0 text-slate-500">所需本地数据</dt>
          <dd className="break-words">{requiresText(rule)}</dd>
        </div>
      </dl>

      {rule.approved ? (
        <div className="space-y-2">
          <Button
            variant="primary"
            onClick={start}
            disabled={busy || tabId === undefined || !rule.enabled}
          >
            {busy ? '处理中…' : '运行'}
          </Button>
          {rule.trigger === 'auto' ? (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="size-4 focus-visible:ring-2 focus-visible:ring-blue-500"
                checked={rule.autoEnabled}
                disabled={busy}
                onChange={(e) => setAuto(e.target.checked)}
              />
              自动运行
            </label>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
          <p className="font-medium">首次运行前请确认</p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li className="break-all">匹配网站：{rule.matchUrls.join('、')}</li>
            <li>所需个人信息：{rule.requires.profile.join('、') || '无'}</li>
            <li>所需凭据：{rule.requires.secret.join('、') || '无'}</li>
            <li>输入方式：{INPUT_MODE_LABEL[rule.inputMode]}</li>
            <li>步骤数：{rule.stepCount}</li>
          </ul>
          <Button variant="primary" onClick={approve} disabled={busy}>
            {busy ? '处理中…' : '确认并启用'}
          </Button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
