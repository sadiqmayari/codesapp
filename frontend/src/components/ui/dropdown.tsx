'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface DropdownItem {
  key: string;
  label: React.ReactNode;
  icon?: React.ElementType;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * Keyboard-navigable menu (UI foundation — Phase A).
 * Up/Down move, Enter selects, Esc closes and returns focus to the trigger,
 * outside click closes.
 */
export function Dropdown({
  trigger,
  items,
  align = 'right',
  className,
  label,
}: {
  /** Rendered inside the trigger button. */
  trigger: React.ReactNode;
  items: DropdownItem[];
  align?: 'left' | 'right';
  className?: string;
  /** Accessible name for the trigger. */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const enabled = items
    .map((it, i) => (it.disabled ? -1 : i))
    .filter((i) => i >= 0);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        close(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, close]);

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  const move = (dir: 1 | -1) => {
    if (!enabled.length) return;
    const pos = enabled.indexOf(active);
    setActive(enabled[(pos + dir + enabled.length) % enabled.length]);
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setActive(enabled[0] ?? 0);
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setActive(enabled[0] ?? 0);
            setOpen(true);
          }
        }}
        className="inline-flex items-center"
      >
        {trigger}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          onKeyDown={onMenuKey}
          className={cn(
            'absolute z-50 mt-2 min-w-[12rem] bg-surface border border-line rounded-xl shadow-lg py-1',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((it, i) => {
            const Icon = it.icon;
            return (
              <button
                key={it.key}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={i === active ? 0 : -1}
                disabled={it.disabled}
                onMouseEnter={() => !it.disabled && setActive(i)}
                onClick={() => {
                  close(false);
                  it.onSelect();
                }}
                className={cn(
                  'w-full flex items-center gap-2 px-4 py-2 text-sm text-left disabled:opacity-40',
                  it.danger ? 'text-red-600' : 'text-ink',
                  i === active ? 'bg-sunken' : 'hover:bg-sunken',
                )}
              >
                {Icon && <Icon size={16} />}
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
