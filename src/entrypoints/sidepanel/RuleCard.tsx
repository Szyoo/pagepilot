import { useState } from 'react';
import { type RuleView, rpc } from '../../shared/rpc';
import { INPUT_MODE_LABEL, TRIGGER_LABEL } from '../../shared/ui/components';
import { useAction } from '../../shared/ui/useAction';
import { startRule } from './actions';
import { requiresText } from './lib';
import { Badge, Btn, ErrorLine } from './parts';

function ApproveSummary({ rule }: { rule: RuleView }) {
  return (
    <div className="confirm-box">
      <p>
        <strong>首次运行前请确认</strong>
      </p>
      <ul>
        <li className="break">匹配网站：{rule.matchUrls.join('、')}</li>
        <li>所需个人信息：{rule.requires.profile.join('、') || '无'}</li>
        <li>所需凭据：{rule.requires.secret.join('、') || '无'}</li>
        <li>输入方式：{INPUT_MODE_LABEL[rule.inputMode]}</li>
        <li>步骤数：{rule.stepCount}</li>
      </ul>
    </div>
  );
}

/**
 * variant=current：当前页的规则，可直接运行（需要 tabId）；未确认时先展开确认摘要。
 * variant=list：规则列表里的规则，可展开看详情，不提供运行。
 */
export function RuleCard({
  rule,
  variant,
  tabId,
}: {
  rule: RuleView;
  variant: 'current' | 'list';
  tabId?: number | undefined;
}) {
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);

  const approve = () => void run(() => rpc('rule.approve', { ruleId: rule.id }));
  const setAuto = (enabled: boolean) =>
    void run(() => rpc('rule.setAuto', { ruleId: rule.id, enabled }));
  // 权限申请需要用户手势：在点击处理函数里直接发起
  const start = () => {
    if (tabId === undefined) return;
    void run(() => startRule(rule, tabId));
  };

  const shownUrls = rule.matchUrls.slice(0, 2);
  const moreUrls = rule.matchUrls.length - shownUrls.length;

  return (
    <article className="card" aria-label={rule.name}>
      <div className="card-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="card-title ellipsis">{rule.name}</h3>
          <p className="small muted">版本 {rule.version}</p>
        </div>
        <div className="badges">
          {variant === 'list' ? (
            <Badge tone={rule.approved ? 'green' : 'yellow'}>
              {rule.approved ? '已确认' : '未确认'}
            </Badge>
          ) : null}
          <Badge tone={rule.trigger === 'auto' ? 'blue' : 'gray'}>
            {TRIGGER_LABEL[rule.trigger]}
          </Badge>
          {variant === 'current' ? <Badge>{INPUT_MODE_LABEL[rule.inputMode]}</Badge> : null}
          {!rule.enabled ? <Badge tone="yellow">已停用</Badge> : null}
        </div>
      </div>

      <dl className="meta">
        {variant === 'list' ? (
          <div>
            <dt>匹配网址：</dt>
            <dd>
              {shownUrls.join('、')}
              {moreUrls > 0 ? ` 等 ${rule.matchUrls.length} 条` : ''}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>所需本地数据：</dt>
          <dd>{requiresText(rule)}</dd>
        </div>
        <div>
          <dt>步骤数：</dt>
          <dd>{rule.stepCount}</dd>
        </div>
      </dl>

      {variant === 'list' && open ? (
        <dl className="meta">
          <div>
            <dt>全部匹配网址：</dt>
            <dd>{rule.matchUrls.join('、') || '无'}</dd>
          </div>
          <div>
            <dt>输入方式：</dt>
            <dd>{INPUT_MODE_LABEL[rule.inputMode]}</dd>
          </div>
          <div>
            <dt>个人信息：</dt>
            <dd>{rule.requires.profile.join('、') || '无'}</dd>
          </div>
          <div>
            <dt>凭据：</dt>
            <dd>{rule.requires.secret.join('、') || '无'}</dd>
          </div>
        </dl>
      ) : null}
      {variant === 'list' ? (
        <button
          type="button"
          className="linkish"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '收起详情' : '展开详情'}
        </button>
      ) : null}

      {!rule.approved ? (
        <>
          {variant === 'current' ? <ApproveSummary rule={rule} /> : null}
          <Btn kind="primary" onClick={approve} disabled={busy}>
            {busy ? '处理中…' : '确认并启用'}
          </Btn>
        </>
      ) : (
        <>
          {variant === 'current' ? (
            <Btn
              kind="primary"
              onClick={start}
              disabled={busy || tabId === undefined || !rule.enabled}
            >
              {busy ? '处理中…' : '运行'}
            </Btn>
          ) : null}
          {rule.trigger === 'auto' ? (
            <label className="check">
              <input
                type="checkbox"
                checked={rule.autoEnabled}
                disabled={busy}
                onChange={(e) => setAuto(e.target.checked)}
              />
              自动运行
            </label>
          ) : null}
        </>
      )}
      <ErrorLine>{error}</ErrorLine>
    </article>
  );
}
