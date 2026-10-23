import { type ReactNode, useId } from 'react';

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
    >
      <header className="space-y-1">
        <h2 id={id} className="text-base font-semibold text-slate-900">
          {title}
        </h2>
        {description ? <p className="text-sm text-slate-500">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}
