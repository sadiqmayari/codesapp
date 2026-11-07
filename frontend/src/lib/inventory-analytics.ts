import { apiFetch } from '@/lib/api';

/** A headline KPI with optional previous-period comparison. */
export interface Kpi {
  value: number | null;
  prev: number | null;
  deltaPct: number | null;
}

export type AbcClass = 'A' | 'B' | 'C';
export type Quadrant = 'star' | 'workhorse' | 'niche' | 'dog' | 'dead';

export interface ProductAnalyticsRow {
  key: string;
  productId: number | null;
  title: string;
  image: string | null;
  category: string | null;
  vendor: string | null;
  sku: string | null;
  price: number;
  cost: number;
  onHand: number;
  reorderLevel: number;
  isBundle: boolean;
  unitsSold: number;
  revenueGross: number;
  discount: number;
  revenueNet: number;
  cogs: number;
  grossProfit: number;
  margin: number;
  stockValue: number;
  sellThrough: number;
  returnedUnits: number;
  returnRate: number;
  velocityPerDay: number;
  daysOfCover: number | null;
  reorderFlag: boolean;
  suggestedReorderQty: number;
  revPrev: number | null;
  revDeltaPct: number | null;
  abcClass: AbcClass;
  quadrant: Quadrant;
}

export interface InventoryProductAnalytics {
  range: { from: string; to: string; periodDays: number };
  currency: string | null;
  generatedAt: string;
  summary: {
    revenueNet: Kpi;
    unitsSold: Kpi;
    grossProfit: Kpi;
    grossMargin: Kpi;
    cogs: Kpi;
    returnRate: Kpi;
    sellThrough: Kpi;
    turnover: Kpi;
    daysOnHand: Kpi;
    gmroi: Kpi;
    stockValue: Kpi;
    onHandUnits: Kpi;
    skus: Kpi;
    outOfStock: Kpi;
    lowStock: Kpi;
    deadStockCount: Kpi;
    deadStockValue: Kpi;
  };
  abc: { aCount: number; bCount: number; cCount: number; aRevShare: number };
  rows: ProductAnalyticsRow[];
  categoryBreakdown: { key: string; revenue: number; units: number; grossProfit: number }[];
  trend: { d: string; revenue: number; units: number }[];
}

export interface InventoryAnalyticsParams {
  from?: string;
  to?: string;
  compare?: boolean;
  storeId?: number;
}

export function getInventoryProductAnalytics(
  params: InventoryAnalyticsParams,
): Promise<InventoryProductAnalytics> {
  return apiFetch<InventoryProductAnalytics>('/analytics/inventory-product', {
    params: {
      from: params.from,
      to: params.to,
      compare: params.compare ? 'true' : undefined,
      storeId: params.storeId,
    },
  });
}

export const QUADRANT_META: Record<Quadrant, { label: string; chip: string }> = {
  star: { label: '★ Star', chip: 'bg-amber-100 text-amber-700' },
  workhorse: { label: 'Workhorse', chip: 'bg-blue-100 text-blue-700' },
  niche: { label: 'Niche', chip: 'bg-violet-100 text-violet-700' },
  dog: { label: 'Low', chip: 'bg-gray-100 text-gray-600' },
  dead: { label: 'Dead', chip: 'bg-red-100 text-red-700' },
};

export const ABC_META: Record<AbcClass, string> = {
  A: 'bg-green-100 text-green-700',
  B: 'bg-amber-100 text-amber-700',
  C: 'bg-gray-100 text-gray-600',
};
