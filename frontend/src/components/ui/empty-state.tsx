import { Inbox, SearchX } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Empty list / no-results state (UI foundation — Phase A): icon, one-line
 * title, a hint, and an optional next action.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: React.ElementType;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center gap-2',
        compact ? 'py-8 px-4' : 'py-14 px-6',
        className,
      )}
    >
      <span
        className={cn(
          'rounded-2xl bg-brand-50 text-brand-700 flex items-center justify-center',
          compact ? 'w-10 h-10' : 'w-14 h-14',
        )}
      >
        <Icon size={compact ? 20 : 26} />
      </span>
      <p className="text-sm font-semibold text-ink mt-1">{title}</p>
      {description && (
        <p className="text-sm text-muted max-w-sm">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * Filtered empty state (Search & filter conventions): use when a list is empty
 * BECAUSE of a search/filter — never show "No X yet" / "Sync from Shopify" in
 * that case. Names the query and offers Clear filters.
 */
export function NoResults({
  query,
  noun = 'results',
  hint,
  onClear,
  compact,
  className,
}: {
  /** The trimmed search text, if any. */
  query?: string;
  /** Plural noun, e.g. "orders", "contacts". */
  noun?: string;
  /** Extra line, e.g. "with filters: Courier: Trax · This month". */
  hint?: React.ReactNode;
  onClear?: () => void;
  compact?: boolean;
  className?: string;
}) {
  const q = query?.trim();
  return (
    <EmptyState
      icon={SearchX}
      compact={compact}
      className={className}
      title={q ? `No ${noun} match “${q}”` : `No ${noun} match these filters`}
      description={hint}
      action={
        onClear ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Clear filters
          </button>
        ) : undefined
      }
    />
  );
}
