'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bookmark, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Saved queue views — the three or four filter combinations a dispatch team
 * re-picks every morning ("Confirmed COD · Lahore · longest waiting").
 *
 * Stored per device in localStorage, not on the server: a view is a personal
 * working preference, it holds no tenant data beyond filter values, and keeping
 * it client-side means no endpoint, no migration and no cross-user surprises.
 * Every read/write is wrapped — a browser with site data blocked simply shows
 * no saved views instead of breaking the board.
 */
export interface SavedView {
  id: string;
  name: string;
  /** Opaque filter snapshot owned by the board. */
  state: Record<string, unknown>;
}

const KEY = 'orders.queue.savedViews.v1';

function read(): SavedView[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedView[]) : [];
  } catch {
    return [];
  }
}

function write(views: SavedView[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(views));
  } catch {
    /* private window / storage disabled — saved views just don't persist */
  }
}

export default function SavedViews({
  current,
  activeId,
  onApply,
  onActiveChange,
}: {
  /** The board's current filter snapshot, saved verbatim. */
  current: Record<string, unknown>;
  activeId: string | null;
  onApply: (state: Record<string, unknown>) => void;
  onActiveChange: (id: string | null) => void;
}) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    setViews(read());
  }, []);

  const save = useCallback(() => {
    const clean = name.trim();
    if (!clean) return;
    const view: SavedView = {
      id: `v${Date.now().toString(36)}`,
      name: clean.slice(0, 40),
      state: current,
    };
    const next = [...views, view].slice(-12); // a working set, not an archive
    setViews(next);
    write(next);
    setName('');
    setNaming(false);
    onActiveChange(view.id);
  }, [name, current, views, onActiveChange]);

  const remove = (id: string) => {
    const next = views.filter((v) => v.id !== id);
    setViews(next);
    write(next);
    if (activeId === id) onActiveChange(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {views.map((v) => (
        <span
          key={v.id}
          className={cn(
            'group inline-flex items-center gap-1 rounded-full border py-1 pl-2.5 pr-1 text-xs transition-colors',
            activeId === v.id
              ? 'border-green-300 bg-green-50 text-green-800'
              : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50',
          )}
        >
          <button
            type="button"
            onClick={() => {
              onApply(v.state);
              onActiveChange(v.id);
            }}
            className="font-medium"
          >
            {v.name}
          </button>
          <button
            type="button"
            onClick={() => remove(v.id)}
            aria-label={`Delete view ${v.name}`}
            title="Delete this view"
            className="rounded-full p-0.5 text-gray-300 hover:bg-gray-200 hover:text-gray-600 group-hover:text-gray-400"
          >
            <X size={11} />
          </button>
        </span>
      ))}

      {naming ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') {
                setNaming(false);
                setName('');
              }
            }}
            placeholder="Name this view"
            maxLength={40}
            className="w-40 rounded-lg border border-gray-300 px-2 py-1 text-xs"
          />
          <button
            type="button"
            onClick={save}
            className="rounded-lg bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setNaming(false);
              setName('');
            }}
            className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-50"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          title="Save the current filters as a view"
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-gray-300 px-2.5 py-1 text-xs text-gray-500 hover:border-gray-400 hover:text-gray-700"
        >
          {views.length === 0 ? (
            <>
              <Bookmark size={12} /> Save this view
            </>
          ) : (
            <>
              <Plus size={12} /> Save
            </>
          )}
        </button>
      )}
    </div>
  );
}
