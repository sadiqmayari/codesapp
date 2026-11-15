'use client';

import { cn } from '@/lib/utils';

/**
 * Accessible on/off switch (`role="switch"`). Use for every boolean setting
 * instead of a hand-rolled toggle or a bare checkbox.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  size = 'md',
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible name — required because the switch has no visible text. */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const sm = size === 'sm';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        sm ? 'h-5 w-9' : 'h-6 w-11',
        checked ? 'bg-brand-600' : 'bg-gray-300 dark:bg-gray-600',
        className,
      )}
    >
      <span
        className={cn(
          'inline-block rounded-full bg-white shadow transition-transform',
          sm ? 'h-3.5 w-3.5' : 'h-[18px] w-[18px]',
          checked
            ? sm
              ? 'translate-x-[18px]'
              : 'translate-x-[22px]'
            : 'translate-x-[3px]',
        )}
      />
    </button>
  );
}
