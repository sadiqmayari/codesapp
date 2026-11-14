/**
 * ONE definition of "returned to origin" (RTO) for every report.
 *
 * A received return ends up with the PARCEL status `cancelled` (the Shopify
 * order is cancelled + archived on receipt and that mirrors back), so checking
 * `status = 'failed'` alone — or checking the order's cancelled_at first —
 * silently drops most returns. A parcel is RTO when it was physically received
 * back, OR the courier reports it returned / failed. A booking cancelled before
 * dispatch (no receipt) is NOT a return.
 */
export const RETURN_STATUSES = ['returned', 'failed'] as const;

/** SQL predicate on a shipments alias. */
export function rtoSql(alias = 's'): string {
  return `(${alias}.received_at IS NOT NULL OR ${alias}.status IN ('returned','failed'))`;
}

/** When the return happened (for date-window bucketing). */
export function rtoAtSql(alias = 's'): string {
  return `COALESCE(${alias}.failed_at, ${alias}.received_at, ${alias}.cancelled_at, ${alias}.updated_at)`;
}

/** In-memory twin of {@link rtoSql}. */
export function isReturned(s: { status?: string | null; received_at?: Date | string | null } | null | undefined): boolean {
  if (!s) return false;
  return s.received_at != null || s.status === 'returned' || s.status === 'failed';
}
