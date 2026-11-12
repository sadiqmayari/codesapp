import { cn } from '@/lib/utils';

export type BadgeTone =
  | 'neutral'
  | 'brand'
  | 'success'
  | 'warn'
  | 'danger'
  | 'info'
  | 'violet';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-gray-100 text-gray-700',
  brand: 'bg-brand-50 text-brand-700',
  success: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-800',
  danger: 'bg-red-50 text-red-700',
  info: 'bg-sky-50 text-sky-700',
  violet: 'bg-violet-50 text-violet-700',
};

/** Status pill (UI foundation — Phase A). */
export function Badge({
  tone = 'neutral',
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
