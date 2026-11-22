import {
  buildable,
  daysCover,
  deltaForSet,
  limitingComponents,
  StaleStockError,
  statusOf,
  suggestReorder,
} from './stock-math';
import { bundleCost, spreadLanded, unitCostOf, weightedAverage } from './cost-math';
import { groupListings, normBarcode, normSku, titleKey } from './sku';
import { interpretWebhook, planPush } from './push-plan';
import { resolveInventorySettings } from './settings';

describe('stock-math', () => {
  it('status', () => {
    expect(statusOf(0, 5)).toBe('out');
    expect(statusOf(-2, 5)).toBe('out');
    expect(statusOf(5, 5)).toBe('low');
    expect(statusOf(6, 5)).toBe('in');
    expect(statusOf(1, 0)).toBe('in');
  });
  it('bundle buildable + limiting', () => {
    const c = [
      { quantity: 1, available: 9 },
      { quantity: 2, available: 9 },
      { quantity: 3, available: 13 },
    ];
    expect(buildable(c)).toBe(4);
    expect(limitingComponents(c)).toEqual([1, 2]);
    expect(buildable([])).toBe(0);
    expect(buildable([{ quantity: 1, available: -3 }])).toBe(0);
  });
  it('days cover + reorder', () => {
    expect(daysCover(10, 0)).toBeNull();
    expect(daysCover(10, 2)).toBe(5);
    expect(suggestReorder({ available: 4, incoming: 0, unitsPerDay: 2, leadTimeDays: 7, coverDays: 30 })).toBe(70);
    expect(suggestReorder({ available: 4, incoming: 0, unitsPerDay: 2, leadTimeDays: 7, coverDays: 30, reorderQty: 24 })).toBe(72);
    expect(suggestReorder({ available: 100, incoming: 0, unitsPerDay: 1, leadTimeDays: 7, coverDays: 30 })).toBe(0);
  });
  it('set → delta, stale → error', () => {
    expect(deltaForSet({ current: 8, seen: 8, target: 5 })).toBe(-3);
    expect(deltaForSet({ current: 8, seen: null, target: 10 })).toBe(2);
    expect(() => deltaForSet({ current: 7, seen: 8, target: 5 })).toThrow(StaleStockError);
  });
});

describe('cost-math', () => {
  it('unit cost precedence', () => {
    expect(unitCostOf({ avgCost: '120.5', costPrice: 100, shopifyUnitCost: 90 })).toBe(120.5);
    expect(unitCostOf({ avgCost: null, costPrice: 100, shopifyUnitCost: 90 })).toBe(100);
    expect(unitCostOf({ shopifyUnitCost: '90' })).toBe(90);
    expect(unitCostOf({})).toBeNull();
  });
  it('weighted average', () => {
    expect(weightedAverage({ oldQty: 20, oldCost: 1380, inQty: 20, inCost: 1460 })).toBe(1420);
    expect(weightedAverage({ oldQty: 0, oldCost: 1000, inQty: 5, inCost: 900 })).toBe(900);
    expect(weightedAverage({ oldQty: -3, oldCost: 1000, inQty: 5, inCost: 900 })).toBe(900);
    expect(weightedAverage({ oldQty: 5, oldCost: null, inQty: 5, inCost: 900 })).toBe(900);
  });
  it('landed spread sums to freight', () => {
    const lines = [
      { qty: 8, unitCost: 1400 },
      { qty: 20, unitCost: 1400 },
      { qty: 3, unitCost: 333.33 },
    ];
    const landed = spreadLanded(lines, 4200);
    const added = landed.reduce((s, u, i) => s + (u - lines[i].unitCost) * lines[i].qty, 0);
    expect(Math.abs(added - 4200)).toBeLessThan(lines.length * 0.01 * 20 + 0.01);
    expect(spreadLanded(lines, 0)).toEqual([1400, 1400, 333.33]);
  });
  it('bundle cost', () => {
    expect(bundleCost([{ quantity: 2, unitCost: 100 }, { quantity: 1, unitCost: 50 }])).toBe(250);
    expect(bundleCost([{ quantity: 2, unitCost: 100 }, { quantity: 1, unitCost: null }])).toBeNull();
  });
});

describe('sku linking', () => {
  it('normalisers', () => {
    expect(normSku('  LK-EMB  M ')).toBe('lk-emb m');
    expect(normSku('')).toBeNull();
    expect(normBarcode('8964 0001-2345')).toBe('896400012345');
    expect(normBarcode('123')).toBeNull();
    expect(titleKey('Lawn Kurta — Embroidered', 'Default Title')).toBe('lawn kurta embroidered|');
    expect(titleKey('Lawn Kurta', 'M / White')).toBe('lawn kurta|m white');
  });
  it('groups across stores by sku, barcode, then title; never two listings of one store', () => {
    const g = groupListings([
      { id: 1, storeId: 1, sku: 'A1', barcode: null, title: 'Kurta', variantTitle: 'S', qty: 5 },
      { id: 2, storeId: 2, sku: 'a1 ', barcode: null, title: 'Kurta X', variantTitle: 'S', qty: 7 },
      { id: 3, storeId: 1, sku: null, barcode: '89640000111', title: 'Shawl', variantTitle: null, qty: 2 },
      { id: 4, storeId: 2, sku: null, barcode: '89640000111', title: 'Shawl new', variantTitle: null, qty: 2 },
      { id: 5, storeId: 1, sku: null, barcode: null, title: 'Dupatta', variantTitle: 'Teal', qty: 1 },
      { id: 6, storeId: 2, sku: null, barcode: null, title: 'dupatta', variantTitle: 'teal', qty: 1 },
      // same store, same title → must stay separate
      { id: 7, storeId: 1, sku: null, barcode: null, title: 'Cap', variantTitle: null, qty: 1 },
      { id: 8, storeId: 1, sku: null, barcode: null, title: 'Cap', variantTitle: null, qty: 3 },
    ]);
    const byFirst = new Map(g.map((x) => [x.listingIds[0], x]));
    expect(byFirst.get(1)).toMatchObject({ listingIds: [1, 2], source: 'sku', conflict: true, qty: 7 });
    expect(byFirst.get(3)).toMatchObject({ listingIds: [3, 4], source: 'barcode', conflict: false });
    expect(byFirst.get(5)).toMatchObject({ listingIds: [5, 6], source: 'title' });
    expect(byFirst.get(7)?.listingIds).toEqual([7]);
    expect(byFirst.get(8)?.listingIds).toEqual([8]);
  });
});

describe('push-plan', () => {
  it('only pushes links whose store value differs', () => {
    const t = planPush({
      levels: new Map([[10, 4], [11, 0]]),
      links: [
        { linkId: 1, locationId: 10 },
        { linkId: 2, locationId: 10 },
        { linkId: 3, locationId: 11 },
      ],
      state: new Map([[1, { lastSeen: 4 }], [2, { lastSeen: 6 }]]),
      track: true,
      isBundle: false,
    });
    expect(t).toEqual([
      { linkId: 2, locationId: 10, target: 4, expected: 6 },
      { linkId: 3, locationId: 11, target: 0, expected: null },
    ]);
    expect(planPush({ levels: new Map(), links: [{ linkId: 1, locationId: 1 }], state: new Map(), track: true, isBundle: true })).toEqual([]);
  });
  it('webhook echo vs change', () => {
    expect(interpretWebhook(null, 5)).toEqual({ kind: 'first', available: 5 });
    expect(interpretWebhook(5, 5)).toEqual({ kind: 'echo' });
    expect(interpretWebhook(5, 4)).toEqual({ kind: 'change', delta: -1, available: 4 });
  });
});

describe('settings', () => {
  it('defaults + clamps', () => {
    const s = resolveInventorySettings({ reconcileMinutes: 5, targetCoverDays: 'x', allowBackorder: true });
    expect(s.reconcileMinutes).toBe(30);
    expect(s.targetCoverDays).toBe(30);
    expect(s.allowBackorder).toBe(true);
    expect(resolveInventorySettings(null).lowStockAlerts).toBe(true);
  });
});
