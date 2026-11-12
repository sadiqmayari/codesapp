import { Inbox } from 'lucide-react';
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
