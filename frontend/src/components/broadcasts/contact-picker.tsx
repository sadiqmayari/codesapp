'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, Search, X } from 'lucide-react';
import { apiFetchEnvelope } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Contact } from '@/lib/crm-types';

const PAGE = 20;

/**
 * Searchable, paginated multi-select over /contacts. Controlled by `value`
 * (selected ids). Keeps a label cache so chips render even after the matching
 * row scrolls out of the current search page.
 */
export function ContactPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [rows, setRows] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const labels = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const env = await apiFetchEnvelope<Contact[]>('/contacts', {
        params: {
          page,
          limit: PAGE,
          search: debounced || undefined,
          status: 'active',
        },
      });
      env.data.forEach((c) =>
        labels.current.set(c.id, c.name || c.phone),
      );
      setRows(env.data);
      const meta = env.meta as { total?: number } | undefined;
      setTotal(meta?.total ?? env.data.length);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [page, debounced]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = new Set(value);
  const toggle = (c: Contact) => {
    labels.current.set(c.id, c.name || c.phone);
    onChange(
      selected.has(c.id)
        ? value.filter((id) => id !== c.id)
        : [...value, c.id],
    );
  };

  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="space-y-3">
      {/* Selected chips */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded-full bg-green-100 text-green-800 px-2.5 py-0.5 text-xs"
            >
              {labels.current.get(id) ?? `#${id}`}
              <button
                type="button"
                onClick={() => onChange(value.filter((x) => x !== id))}
                aria-label="Remove"
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-xs text-gray-500 hover:text-red-600 underline ml-1"
          >
            Clear all
          </button>
        </div>
      )}

      <div className="relative">
        <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search contacts by name or phone…"
          type="search"
          autoComplete="off"
          className="w-full pl-9 pr-9 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
        />
        {loading && (
          <Loader2
            size={16}
            className="absolute right-3 top-2.5 text-gray-400 animate-spin"
          />
        )}
      </div>

      <div className="border border-gray-200 rounded-lg max-h-60 overflow-y-auto divide-y divide-gray-100">
        {rows.length === 0 && !loading ? (
          <p className="px-3 py-4 text-xs text-gray-400">No contacts found.</p>
        ) : (
          rows.map((c) => {
            const on = selected.has(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggle(c)}
                className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-3"
              >
                <span
                  className={cn(
                    'w-4 h-4 rounded border flex items-center justify-center shrink-0',
                    on
                      ? 'bg-green-600 border-green-600 text-white'
                      : 'border-gray-300',
                  )}
                >
                  {on && <Check size={12} />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-gray-900 truncate">
                    {c.name || c.phone}
                  </span>
                  {c.name && (
                    <span className="block text-[11px] text-gray-400 truncate">
                      {c.phone}
                    </span>
                  )}
                </span>
              </button>
            );
          })
        )}
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>
            Page {page} of {pages} · {total} contacts
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-2.5 py-1 rounded border border-gray-300 disabled:opacity-40"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
              className="px-2.5 py-1 rounded border border-gray-300 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-gray-400">
        {value.length} contact{value.length === 1 ? '' : 's'} selected.
      </p>
    </div>
  );
}
