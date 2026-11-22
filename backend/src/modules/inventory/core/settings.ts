/**
 * Inventory v2 tenant settings — ONE JSON blob on companies.inventory_settings,
 * read ONLY through resolveInventorySettings (merges a partial/legacy/null blob
 * over the defaults + clamps).
 */

export interface InventorySettings {
  /** agents / AI may sell an item with Available 0 */
  allowBackorder: boolean;
  /** create-order modal warns when qty > available */
  warnOverAvailable: boolean;
  lowStockAlerts: boolean;
  /** daily owner email digest of low + out items */
  dailyDigest: boolean;
  /** alert when an out-of-stock item is in an ad that spent today */
  adsOutOfStockAlert: boolean;
  /** back-in-stock: offer a WhatsApp template to the waitlist */
  backInStockOffer: boolean;
  /** days of cover the reorder suggestion targets beyond lead time */
  targetCoverDays: number;
  /** default supplier lead time when the item/supplier has none */
  defaultLeadTimeDays: number;
  /** A-class items get a cycle-count nudge every N days */
  countCadenceDays: number;
  /** reconcile the stores against the pool every N minutes (worker) */
  reconcileMinutes: number;
}

export const DEFAULT_INVENTORY_SETTINGS: InventorySettings = {
  allowBackorder: false,
  warnOverAvailable: true,
  lowStockAlerts: true,
  dailyDigest: false,
  adsOutOfStockAlert: true,
  backInStockOffer: true,
  targetCoverDays: 30,
  defaultLeadTimeDays: 7,
  countCadenceDays: 30,
  reconcileMinutes: 60,
};

const clampInt = (v: unknown, lo: number, hi: number, def: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};
const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);

export function resolveInventorySettings(raw: unknown): InventorySettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_INVENTORY_SETTINGS;
  return {
    allowBackorder: bool(r.allowBackorder, d.allowBackorder),
    warnOverAvailable: bool(r.warnOverAvailable, d.warnOverAvailable),
    lowStockAlerts: bool(r.lowStockAlerts, d.lowStockAlerts),
    dailyDigest: bool(r.dailyDigest, d.dailyDigest),
    adsOutOfStockAlert: bool(r.adsOutOfStockAlert, d.adsOutOfStockAlert),
    backInStockOffer: bool(r.backInStockOffer, d.backInStockOffer),
    targetCoverDays: clampInt(r.targetCoverDays, 1, 365, d.targetCoverDays),
    defaultLeadTimeDays: clampInt(r.defaultLeadTimeDays, 0, 180, d.defaultLeadTimeDays),
    countCadenceDays: clampInt(r.countCadenceDays, 7, 365, d.countCadenceDays),
    reconcileMinutes: clampInt(r.reconcileMinutes, 30, 1440, d.reconcileMinutes),
  };
}
