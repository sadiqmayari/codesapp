'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Search, ShoppingBag } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';

export interface CatalogProduct {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  price: string;
  sku: string | null;
  image: string | null;
  productUrl: string | null;
  available: boolean;
}

/**
 * Shopify catalog browser. Lists products (image + name + price) from the
 * store via the existing GET /api/shopify/products, and hands the chosen one
 * back so the agent can send it to the customer. No backend change.
 */
export default function CatalogPicker({
  onPick,
  onClose,
}: {
  onPick: (p: CatalogProduct) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<CatalogProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = (q: string) => {
    setLoading(true);
    apiFetch<CatalogProduct[]>('/shopify/products', {
      params: { query: q || undefined },
    })
      .then((rows) => setItems(Array.isArray(rows) ? rows : []))
      .catch((e) => {
        toast.error(
          e instanceof ApiError ? e.userMessage : 'Could not load products',
        );
        setItems([]);
      })
      .finally(() => setLoading(false));
  };

  // Initial load + debounced search.
  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => load(query.trim()), 300);
    return () => {
      if (debRef.current) clearTimeout(debRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <Modal open onClose={onClose} title="Send from catalog">
      <div className="space-y-3">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products…"
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>

        <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1">
          {loading ? (
            <div className="py-10 flex justify-center text-gray-400">
              <Loader2 className="animate-spin" size={22} />
            </div>
          ) : items.length === 0 ? (
            <div className="py-10 text-center text-sm text-gray-400">
              No products found.
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {items.map((p) => (
                <li key={p.variantId}>
                  <button
                    type="button"
                    onClick={() => onPick(p)}
                    className="w-full flex items-center gap-3 py-2.5 text-left hover:bg-gray-50 rounded-lg px-1"
                  >
                    {p.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.image}
                        alt=""
                        className="w-12 h-12 rounded object-cover bg-gray-100 shrink-0"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded bg-gray-100 flex items-center justify-center text-gray-400 shrink-0">
                        <ShoppingBag size={18} />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {p.productTitle}
                        {p.variantTitle &&
                        p.variantTitle !== 'Default Title' ? (
                          <span className="text-gray-500 font-normal">
                            {' '}
                            · {p.variantTitle}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-gray-500">
                        PKR {p.price}
                        {!p.available && (
                          <span className="ml-2 text-red-500">
                            out of stock
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
