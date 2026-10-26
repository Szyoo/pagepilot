const STEPS = ['开始录制', '在页面上操作', '停止并检查步骤', '上报并去管理页生成规则'];

/** current：当前步骤序号（1 起）；大于步骤数表示全部完成 */
export function StepGuide({ current }: { current: number }) {
  return (
    <ol className="guide" aria-label="录制流程">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const cls = n < current ? 'done' : n === current ? 'current' : '';
        return (
          <li key={label} className={cls} aria-current={n === current ? 'step' : undefined}>
            <span className="num" aria-hidden="true">
              {n < current ? '✓' : n}
            </span>
            <span>{label}</span>
            {n === current ? <span className="next">下一步</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
