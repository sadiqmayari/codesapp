'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { SearchInput } from '@/components/ui/search-input';
import { stockSearch, type StockHit } from '@/lib/inventory-ops';
import { useDebouncedValue } from '@/lib/use-list-query';
import { itemName, Thumb } from './shared';

/**
 * Find an inventory item by title / SKU / code and pick it. Used by purchase
 * orders, transfers and counts. Bundles are skipped (they have no own stock).
 */
export function ItemPicker({
  onPick,
  exclude,
  placeholder = 'Add an item — search title, SKU or code',
}: {
  onPick: (item: StockHit) => void;
  exclude?: Set<number>;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q, 250);
  const [rows, setRows] = useState<StockHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if (!dq.trim()) {
      setRows([]);
      return;
    }
    const my = ++seq.current;
    setLoading(true);
    stockSearch(dq)
      .then((r) => my === seq.current && setRows(r.filter((x) => !x.isBundle)))
      .catch(() => my === seq.current && setRows([]))
      .finally(() => my === seq.current && setLoading(false));
  }, [dq]);
  return (
    <div className="relative">
      <SearchInput
        value={q}
        onChange={(v) => {
          setQ(v);
          setOpen(true);
        }}
        loading={loading}
        placeholder={placeholder}
        aria-label="Find an item"
      />
      {open && dq.trim() && (
        <div className="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded-xl border border-line bg-surface shadow-xl">
          {rows.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted">{loading ? 'Searching…' : 'No items match.'}</p>
          ) : (
            rows.map((r) => {
              const taken = exclude?.has(r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  disabled={taken}
                  onClick={() => {
                    onPick(r);
                    setQ('');
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-sunken disabled:opacity-50"
                >
                  <Thumb src={r.image} alt="" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-ink">{itemName(r)}</span>
                    <span className="text-xs text-muted">
                      {r.sku ?? 'no SKU'} · {r.available} available
                    </span>
                  </span>
                  {taken ? <span className="text-xs text-muted">added</span> : <Plus className="h-4 w-4 text-brand-600" aria-hidden="true" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
