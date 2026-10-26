import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Kind = 'default' | 'primary' | 'danger' | 'ghost';
type Size = 'main' | 'std' | 'sm';

export function Btn({
  kind = 'default',
  size = 'std',
  inline = false,
  pill = false,
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: Kind;
  size?: Size;
  inline?: boolean;
  pill?: boolean;
}) {
  const cls = [
    'btn',
    kind === 'default' ? '' : kind,
    size === 'std' ? '' : size,
    inline ? 'inline' : '',
    pill ? 'pill' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <button type={type} {...props} className={cls} />;
}

export function Badge({
  tone = 'gray',
  children,
}: {
  tone?: 'gray' | 'blue' | 'green' | 'yellow' | 'red';
  children: ReactNode;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Empty({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {sub ? <p className="empty-sub">{sub}</p> : null}
      {children}
    </div>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="error-text">
      {children}
    </p>
  );
}
