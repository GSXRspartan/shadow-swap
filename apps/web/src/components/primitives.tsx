/**
 * Presentational primitives.
 *
 * Every interactive element is a real `<button>` / `<a>` with an accessible
 * name, a visible focus ring, and — where the icon carries meaning — a
 * screen-reader label. Status is never colour-only: `Badge` always renders a
 * text label and a glyph.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { formatAddress } from '../lib/format.js';
import { safeLabel } from '../lib/sanitize.js';

export function Card({ children, className = '', ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <section className={`card ${className}`.trim()} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({ title, actions, id }: { title: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <header className="card__head">
      <h2 className="card__title" id={id}>
        {title}
      </h2>
      {actions}
    </header>
  );
}

export type BadgeTone = 'neutral' | 'ok' | 'info' | 'warn' | 'danger' | 'testnet';

const BADGE_GLYPH: Record<BadgeTone, string> = {
  neutral: '•',
  ok: '✓',
  info: 'i',
  warn: '!',
  danger: '×',
  testnet: '▲',
};

export function Badge({ tone = 'neutral', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone === 'neutral' ? '' : `badge--${tone}`}`.trim()} title={title}>
      <span aria-hidden="true">{BADGE_GLYPH[tone]}</span>
      <span>{children}</span>
    </span>
  );
}

export function Skeleton({ width = '100%', height = 14 }: { width?: string; height?: number }) {
  return <div className="skeleton" style={{ width, height }} aria-hidden="true" />;
}

export function LoadingBlock({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="stack" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} width={index === rows - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      <p className="hint" style={{ maxWidth: '46ch' }}>
        {detail}
      </p>
      {action}
    </div>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'danger';
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const glyph = tone === 'danger' ? '×' : tone === 'warn' ? '!' : 'i';
  return (
    <div className={`notice notice--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="notice__glyph" aria-hidden="true">
        {glyph}
      </span>
      <div className="stack" style={{ gap: 'var(--s-1)', flex: 1 }}>
        <strong style={{ fontSize: 'var(--text-md)' }}>{title}</strong>
        {children !== undefined && <div className="hint">{children}</div>}
        {action}
      </div>
    </div>
  );
}

/**
 * Exact-identity affordance. Renders the human label but always exposes the
 * exact ResourceAddress behind a hover/focus tooltip, so two same-symbol tokens
 * remain distinguishable.
 */
export function IdentityTooltip({
  label,
  resourceAddress,
  classification,
  classificationNote,
  symbol,
}: {
  label: ReactNode;
  resourceAddress: string;
  classification?: string;
  classificationNote?: string;
  symbol?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="tooltip-host" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
      <span tabIndex={0} aria-describedby={id} className="truncate">
        {label}
      </span>
      {open && (
        <span className="tooltip" id={id} role="tooltip">
          <span className="label">Resource address</span>
          <br />
          <span className="mono">{resourceAddress}</span>
          {symbol !== undefined && symbol !== '' && (
            <>
              <br />
              <span className="muted">Symbol: {safeLabel(symbol, 24)} (label only, not identity)</span>
            </>
          )}
          {classification !== undefined && (
            <>
              <br />
              <span className="muted">Classification: {classification}</span>
            </>
          )}
          {classificationNote !== undefined && (
            <>
              <br />
              <span className="muted">{classificationNote}</span>
            </>
          )}
        </span>
      )}
    </span>
  );
}

export function ShortAddress({ address }: { address: string }) {
  return (
    <span className="mono muted" title={address}>
      {formatAddress(address, 8, 6)}
    </span>
  );
}

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  trailing?: ReactNode;
}

/** Label + control + hint/error, wired with the right ARIA relationships. */
export function Field({ label, hint, error, children, trailing }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint !== undefined ? hintId : undefined, error !== undefined ? errId : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <div className="spread">
        <label className="label" htmlFor={id}>
          {label}
        </label>
        {trailing}
      </div>
      {children(id, describedBy)}
      {hint !== undefined && (
        <span className="hint" id={hintId}>
          {hint}
        </span>
      )}
      {error !== undefined && (
        <span className="hint danger" id={errId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Bottom sheet on phones, centred dialog on larger screens. */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
        <div className="dialog__head">
          <h2 className="card__title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close dialog">
            <span aria-hidden="true">×</span>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean; title?: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="row" role="group" aria-label={label} style={{ gap: 2, flexWrap: 'wrap' }}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="btn btn--sm"
          aria-pressed={value === option.value}
          disabled={option.disabled === true}
          title={option.title}
          onClick={() => onChange(option.value)}
          style={
            value === option.value
              ? { background: 'var(--accent-wash)', borderColor: 'var(--accent-line)', color: 'var(--accent)' }
              : { background: 'transparent', borderColor: 'transparent', color: 'var(--text-3)' }
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function DataRow({ label, value, title, tone }: { label: string; value: ReactNode; title?: string; tone?: 'up' | 'down' | 'warn' }) {
  return (
    <div className="spread" title={title}>
      <span className="label">{label}</span>
      <span className={`num ${tone ?? ''}`.trim()} style={{ fontWeight: 600 }}>
        {value}
      </span>
    </div>
  );
}
