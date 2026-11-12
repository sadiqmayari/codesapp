'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface RowMenuItem {
  key: string;
  label: string;
  icon?: React.ElementType;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Start a new group (draws a divider above this item). */
  divider?: boolean;
}

/**
 * The per-row "⋯" overflow menu. FIXED-positioned (not absolute) so it is never
 * clipped by the board's bounded, scrollable table viewport; flips above the
 * trigger near the bottom of the screen. ↑/↓/Enter/Esc keyboard support; closes
 * on outside click, scroll and resize.
 */
export function RowMenu({
  items,
  label,
  className,
  trigger,
}: {
  items: RowMenuItem[];
  label: string;
  className?: string;
  /** Optional custom trigger content (defaults to a ⋯ icon). */
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setPos(null);
    if (refocus) btnRef.current?.focus();
  }, []);

  // Position after the menu has rendered (needs its measured size).
  useLayoutEffect(() => {
    if (!open || !btnRef.current || !menuRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const w = menuRef.current.offsetWidth;
    const h = menuRef.current.offsetHeight;
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    const below = r.bottom + 4;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below;
    setPos({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close(false);
    };
    const onScroll = () => close(false);
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, close]);

  useEffect(() => {
    if (open && pos) itemRefs.current[active]?.focus();
  }, [open, pos, active]);

  const onKey = (e: React.KeyboardEvent) => {
    // Keep the board's j/k/x/b shortcuts from firing while the menu is open.
    e.stopPropagation();
    if (!enabled.length) return;
    const at = enabled.indexOf(active);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(enabled[(at + 1) % enabled.length]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(enabled[(at - 1 + enabled.length) % enabled.length]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  if (!items.length) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (open) {
            close(false);
          } else {
            setActive(enabled[0] ?? 0);
            setOpen(true);
          }
        }}
        className={cn(
          'inline-flex h-8 min-w-[2rem] items-center justify-center gap-1 rounded-lg border border-transparent px-1.5 text-muted hover:border-line hover:bg-surface hover:text-ink',
          open && 'border-line bg-surface text-ink',
          className,
        )}
      >
        {trigger ?? <MoreHorizontal size={16} />}
      </button>
      {/* Portalled to <body>: a sticky table cell is its own stacking
          context and would trap the menu under later rows. */}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={onKey}
          onClick={(e) => e.stopPropagation()}
          style={{
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            visibility: pos ? 'visible' : 'hidden',
          }}
          className="fixed z-[60] min-w-[210px] rounded-xl border border-line bg-surface p-1.5 text-left shadow-lg"
        >
          {items.map((it, i) => {
            const Icon = it.icon;
            return (
              <div key={it.key}>
                {it.divider && i > 0 && <div className="my-1 border-t border-line" />}
                <button
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  tabIndex={i === active ? 0 : -1}
                  onClick={() => {
                    close(false);
                    it.onSelect();
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-semibold focus:outline-none disabled:opacity-40',
                    it.danger
                      ? 'text-rose-700 hover:bg-rose-50 focus:bg-rose-50'
                      : 'text-ink hover:bg-sunken focus:bg-sunken',
                  )}
                >
                  {Icon && <Icon size={15} className="shrink-0 opacity-80" />}
                  {it.label}
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
