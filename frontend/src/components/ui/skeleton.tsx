import { cn } from '@/lib/utils';

/**
 * Shimmer placeholder (UI foundation — Phase A). Use for INITIAL loads in
 * place of a full-panel spinner so the layout does not jump when data lands.
 * Keep inline spinners (button busy state, "load more") as they are.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        'rounded-md bg-gradient-to-r from-gray-100 via-gray-200 to-gray-100 bg-[length:200%_100%] motion-safe:animate-shimmer',
        className,
      )}
    />
  );
}

/** List/table placeholder rows with two text lines. */
export function SkeletonRows({
  rows = 6,
  avatar = false,
  className,
}: {
  rows?: number;
  avatar?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn('flex flex-col divide-y divide-line', className)}
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          {avatar && <Skeleton className="w-10 h-10 rounded-full shrink-0" />}
          <div className="flex-1 flex flex-col gap-2 min-w-0">
            <Skeleton className={cn('h-3', i % 2 ? 'w-1/2' : 'w-2/3')} />
            <Skeleton className={cn('h-2.5', i % 3 ? 'w-1/3' : 'w-2/5')} />
          </div>
          <Skeleton className="h-3 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** KPI-grid placeholder. */
export function SkeletonCards({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn('grid grid-cols-2 lg:grid-cols-4 gap-4', className)}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="bg-surface border border-line rounded-xl p-4 flex flex-col gap-3"
        >
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      ))}
    </div>
  );
}
