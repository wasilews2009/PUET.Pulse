import { X } from '@phosphor-icons/react';
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useTranslation } from 'react-i18next';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

const motion = 'transition-[background-color,color,opacity,transform] duration-300 ease-pulse active:scale-[0.98]';

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  primary: 'bg-primary text-on-primary hover:bg-primary-hover',
  accent: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-hover',
  ghost: 'text-ink hover:bg-surface-hover',
  danger: 'bg-surface text-danger border border-line hover:bg-surface-hover',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'md' | 'sm'; icon?: ReactNode; loading?: boolean }
>(function Button({ variant = 'primary', size = 'md', icon, loading, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50',
        size === 'md' ? 'button-md px-3 py-2' : 'button-sm px-3 py-1',
        motion,
        variants[variant],
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: 'default' | 'sidebar' }>(
  function IconButton({ label, tone = 'default', className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        {...rest}
        className={cx(
          'inline-flex size-10 shrink-0 items-center justify-center rounded-lg disabled:opacity-40',
          motion,
          tone === 'sidebar' ? 'text-sidebar-text hover:bg-sidebar-hover' : 'text-muted hover:bg-surface-hover hover:text-ink',
          className,
        )}
      >
        {children}
      </button>
    );
  },
);

const AVATAR_TONES = ['bg-[#163C56]', 'bg-[#1C4966]', 'bg-[#2A6A92]', 'bg-[#C83D1E]', 'bg-[#3D5A6C]', 'bg-[#1F7A4D]'];

export function initials(name: string | null | undefined): string {
  if (!name) return '·';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '·';
}

export function Avatar({ name, id, size = 'md', presence }: { name: string | null | undefined; id: string; size?: 'sm' | 'md' | 'lg'; presence?: string | undefined }) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const dims = size === 'sm' ? 'size-8 caption-3' : size === 'lg' ? 'size-12 title-3' : 'size-10 body-4';
  return (
    <span className="relative inline-flex shrink-0" aria-hidden="true">
      <span className={cx('inline-flex items-center justify-center rounded-full text-white', dims, AVATAR_TONES[h % AVATAR_TONES.length])}>{initials(name)}</span>
      {presence && presence !== 'OFFLINE' && (
        <span
          className={cx(
            'absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-surface',
            presence === 'ONLINE' ? 'bg-success' : presence === 'IN_CLASS' || presence === 'DO_NOT_DISTURB' ? 'bg-accent' : 'bg-[#C9A227]',
          )}
        />
      )}
    </span>
  );
}

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'navy' | 'accent' | 'success' | 'danger'; children: ReactNode; className?: string }) {
  const tones = {
    neutral: 'bg-surface-hover text-muted',
    navy: 'bg-navy text-white',
    accent: 'bg-accent text-on-accent',
    success: 'bg-success text-white',
    danger: 'bg-danger text-white',
  } as const;
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 caption-3 whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx('pulse-skeleton block rounded-lg', className)} />;
}

export function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-surface text-primary shadow-sm ring-1 ring-line">{icon}</span>
      <h2 className="heading-6">{title}</h2>
      {hint && <p className="body-6 text-muted">{hint}</p>}
      {action}
    </div>
  );
}

export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-line bg-surface px-3 py-2 body-6 text-danger">
      {children}
    </p>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string | undefined; error?: string | undefined; children: (id: string, describedBy?: string) => ReactNode }) {
  const id = useId();
  const hintId = hint || error ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="title-4">
        {label}
      </label>
      {children(id, hintId)}
      {(error || hint) && (
        <p id={hintId} className={cx('caption-5', error ? 'text-danger' : 'text-muted')}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 body-6 text-ink placeholder:text-muted transition-colors duration-300 ease-pulse focus:border-primary focus:outline-none focus-visible:outline-2';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} {...rest} className={cx(inputCls, className)} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} {...rest} className={cx(inputCls, 'resize-none', className)} />;
});

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={cx(inputCls, 'pr-8', className)} />;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-3 body-6', disabled && 'cursor-not-allowed opacity-50')}>
      <input type="checkbox" role="switch" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden="true"
        className="relative h-6 w-10 rounded-full bg-line transition-colors duration-300 ease-pulse peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--pulse-focus)] after:absolute after:top-1 after:left-1 after:size-4 after:rounded-full after:bg-white after:transition-transform after:duration-300 after:ease-pulse peer-checked:after:translate-x-4"
      />
      {label}
    </label>
  );
}

/** Modal dialog on the native <dialog> element: focus trap, Escape and backdrop come from the browser. */
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useTranslation();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="pulse-dialog-title"
      className={cx(
        'm-auto w-[calc(100%-32px)] rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/50',
        wide ? 'max-w-3xl' : 'max-w-lg',
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-center justify-between gap-3 border-b border-line px-6 py-4">
            <h2 id="pulse-dialog-title" className="heading-6">
              {title}
            </h2>
            <IconButton label={t('app.close')} onClick={onClose}>
              <X size={20} />
            </IconButton>
          </header>
          <div className="overflow-y-auto px-6 py-4">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-6 py-4">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export function formatBytes(n: number, lang: string): string {
  const units = lang === 'en' ? ['B', 'KB', 'MB', 'GB'] : ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(lang === 'en' ? 'en-GB' : 'uk-UA', { maximumFractionDigits: i === 0 ? 0 : 1 })} ${units[i]}`;
}

export function formatTime(iso: string, lang: string) {
  return new Date(iso).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'uk-UA', { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(iso: string, lang: string) {
  return new Date(iso).toLocaleString(lang === 'en' ? 'en-GB' : 'uk-UA', { dateStyle: 'medium', timeStyle: 'short' });
}
