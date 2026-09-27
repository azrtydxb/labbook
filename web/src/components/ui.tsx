import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import type { RunStatus } from '../lib/types';

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  loading,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
  const sizes = { sm: 'h-7 px-2.5 text-xs', md: 'h-9 px-3.5 text-sm' };
  const variants: Record<Variant, string> = {
    primary: 'bg-accent text-accent-ink hover:brightness-110',
    secondary: 'border border-rule-strong bg-panel text-ink hover:bg-panel-2',
    ghost: 'text-ink-2 hover:text-ink hover:bg-panel-2',
    danger: 'border border-fail/40 text-fail hover:bg-fail-soft',
  };
  return (
    <button
      className={cx(base, sizes[size], variants[variant], className)}
      disabled={loading || rest.disabled}
      {...rest}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClass,
  subtitle,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={cx('rounded-xl border border-rule bg-panel', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx('p-4', bodyClass)}>{children}</div>
    </section>
  );
}

const STATUS: Record<RunStatus, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  pass: { label: 'Pass', cls: 'bg-pass-soft text-pass', Icon: CheckCircle2 },
  fail: { label: 'Fail', cls: 'bg-fail-soft text-fail', Icon: XCircle },
  error: { label: 'Error', cls: 'bg-error-soft text-error', Icon: AlertTriangle },
  info: { label: 'Info', cls: 'bg-info-soft text-info', Icon: Info },
};

export function StatusBadge({ status, compact }: { status: RunStatus; compact?: boolean }) {
  const s = STATUS[status];
  return (
    <span
      className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', s.cls)}
    >
      <s.Icon className="size-3.5" aria-hidden />
      {compact ? <span className="sr-only">{s.label}</span> : s.label}
    </span>
  );
}

export function VerdictMark({ verdict }: { verdict: 'pass' | 'fail' | 'none' | 'missing' }) {
  if (verdict === 'pass')
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-pass">
        <CheckCircle2 className="size-3.5" aria-hidden /> within bounds
      </span>
    );
  if (verdict === 'fail')
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-fail">
        <XCircle className="size-3.5" aria-hidden /> out of bounds
      </span>
    );
  if (verdict === 'missing') return <span className="text-xs text-ink-3">not recorded</span>;
  return <span className="text-xs text-ink-3">no bounds</span>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-ink-3" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}…
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-md border border-fail/30 bg-fail-soft px-3 py-2 text-sm text-fail">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-rule-strong px-6 py-10 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-ink-2">{children}</div>}
    </div>
  );
}

const field =
  'w-full rounded-md border border-rule-strong bg-panel px-3 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(field, 'h-9', props.className)} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(field, 'h-9 pr-8', props.className)} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cx(field, 'py-2 font-mono text-[13px] leading-relaxed', props.className)}
    />
  );
}

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <span className="mb-1 block text-xs font-medium text-ink-2">
      {children}
      {hint && <span className="ml-1 font-normal text-ink-3">{hint}</span>}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded border border-rule px-1.5 py-0.5 text-[11px] text-ink-2">{children}</span>;
}

export function PageHeader({
  title,
  kicker,
  actions,
  children,
}: {
  title: ReactNode;
  kicker?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {kicker && <div className="mb-1 text-sm text-ink-3">{kicker}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">{title}</h1>
        {children && <div className="mt-2 max-w-3xl text-sm text-ink-2">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Delta({
  pct,
  improved,
}: {
  pct: number | null | undefined;
  improved: boolean | null | undefined;
}) {
  if (pct === null || pct === undefined || !Number.isFinite(pct))
    return <span className="text-ink-3">–</span>;
  const s = `${pct > 0 ? '+' : ''}${(pct * 100).toFixed(Math.abs(pct) < 0.1 ? 1 : 0)}%`;
  const cls = improved === true ? 'text-pass' : improved === false ? 'text-fail' : 'text-ink-2';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '';
  return (
    <span className={cx('whitespace-nowrap text-xs font-medium', cls)}>
      <span aria-hidden className="mr-0.5 text-[9px]">
        {arrow}
      </span>
      {s}
      <span className="sr-only">{improved === true ? ' better' : improved === false ? ' worse' : ''}</span>
    </span>
  );
}
