'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { classifySearch, SEARCH_KIND_LABEL, type SearchKind } from '@/lib/search';

/**
 * Shared search box (Search & filter conventions). Icon, visible × clear,
 * optional spinner, Esc clears, optional `/` focus shortcut and an optional
 * "detected as" chip (Order # / Phone / Tracking) for smart commerce search.
 *
 * Controlled: pass the RAW value and debounce in the caller
 * (`useDebouncedValue`) — the box itself never delays typing.
 */
export const SearchInput = forwardRef<
  HTMLInputElement | null,
  {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    loading?: boolean;
    /** Show the Order # / Phone / Tracking chip. */
    detect?: boolean | SearchKind[];
    /** Focus on `/` when not typing elsewhere. */
    slashShortcut?: boolean;
    autoFocus?: boolean;
    className?: string;
    inputClassName?: string;
    'aria-label'?: string;
    onSubmit?: () => void;
    size?: 'sm' | 'md';
  }
>(function SearchInput(
  {
    value,
    onChange,
    placeholder = 'Search…',
    loading,
    detect,
    slashShortcut,
    autoFocus,
    className,
    inputClassName,
    onSubmit,
    size = 'md',
    ...rest
  },
  ref,
) {
  const inner = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLInputElement);

  useEffect(() => {
    if (!slashShortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[aria-modal="true"],[data-order-drawer]')) return;
      e.preventDefault();
      inner.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [slashShortcut]);

  const kind = detect ? classifySearch(value) : null;
  const allowed = Array.isArray(detect) ? detect : null;
  const chip =
    kind && kind !== 'text' && (!allowed || allowed.includes(kind)) ? SEARCH_KIND_LABEL[kind] : '';

  return (
    <div className={cn('relative flex items-center min-w-0', className)}>
      <Search
        size={size === 'sm' ? 14 : 16}
        className="pointer-events-none absolute left-3 text-muted"
        aria-hidden
      />
      <input
        ref={inner}
        type="text"
        inputMode="search"
        enterKeyHint="search"
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        aria-label={rest['aria-label'] ?? placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          } else if (e.key === 'Enter' && onSubmit) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className={cn(
          'w-full rounded-lg border border-line bg-surface text-ink placeholder:text-muted',
          'focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500',
          size === 'sm' ? 'h-8 pl-8 text-[13px]' : 'h-9 pl-9 text-sm',
          value || loading || slashShortcut ? 'pr-24' : 'pr-3',
          inputClassName,
        )}
      />
      <div className="absolute right-2 flex items-center gap-1.5">
        {chip && (
          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-bold text-brand-700 whitespace-nowrap">
            {chip}
          </span>
        )}
        {loading && <Loader2 size={14} className="animate-spin text-muted" aria-hidden />}
        {value ? (
          <button
            type="button"
            onClick={() => {
              onChange('');
              inner.current?.focus();
            }}
            className="flex h-5 w-5 items-center justify-center rounded-full bg-sunken text-muted hover:text-ink"
            aria-label="Clear search"
          >
            <X size={12} />
          </button>
        ) : (
          slashShortcut && (
            <kbd className="hidden sm:inline rounded border border-line px-1.5 text-[10px] font-mono text-muted">
              /
            </kbd>
          )
        )}
      </div>
    </div>
  );
});
