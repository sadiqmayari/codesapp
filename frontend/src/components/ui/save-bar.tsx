'use client';

import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Floating "Unsaved changes · Discard · Save" bar. Render it once per page;
 * it slides in while `dirty` is true and warns before leaving the tab.
 */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  label = 'Unsaved changes',
}: {
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  label?: string;
}) {
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  return (
    <div
      role="status"
      aria-hidden={!dirty}
      className={cn(
        'fixed bottom-20 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-2xl bg-gray-900 py-2 pl-5 pr-2 text-sm text-gray-100 shadow-2xl transition-all duration-200 md:bottom-6',
        dirty
          ? 'translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-6 opacity-0',
      )}
    >
      <span className="font-medium">{label}</span>
      <button
        type="button"
        onClick={onDiscard}
        disabled={saving}
        tabIndex={dirty ? 0 : -1}
        className="h-8 rounded-lg border border-gray-700 px-3 font-semibold hover:bg-gray-800 disabled:opacity-50"
      >
        Discard
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        tabIndex={dirty ? 0 : -1}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {saving && <Loader2 size={14} className="animate-spin" />}
        Save changes
      </button>
    </div>
  );
}
