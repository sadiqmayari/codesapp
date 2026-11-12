'use client';

import { useId, useState } from 'react';
import { X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

/** Case-insensitive de-dupe — the ONE tag rule (matches the backend `normalizeTags`). */
export function addTag(tags: string[], raw: string): string[] {
  const t = raw.trim().slice(0, 50);
  if (!t || tags.some((x) => x.toLowerCase() === t.toLowerCase())) return tags;
  return [...tags, t];
}

/**
 * Shared tag chips editor (Contacts 360) — used by the contact form, the
 * Contact 360 profile and the segment builder. `onChange` may be async: the
 * editor shows a busy state and keeps the draft until the save succeeds.
 * `suggestions` (e.g. `/contacts/tags`) feed a native datalist.
 */
export function TagEditor({
  tags,
  onChange,
  suggestions = [],
  label = 'Add tag',
  placeholder = 'Add tag…',
  disabled = false,
  className,
}: {
  tags: string[];
  onChange: (next: string[]) => Promise<void> | void;
  suggestions?: string[];
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const toast = useToast();
  const listId = useId();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (next: string[], onOk?: () => void) => {
    if (next === tags) {
      onOk?.();
      return;
    }
    setBusy(true);
    try {
      await onChange(next);
      onOk?.();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not update tags');
    } finally {
      setBusy(false);
    }
  };

  const commit = () => {
    if (!value.trim()) return;
    void save(addTag(tags, value), () => setValue(''));
  };

  const lowered = new Set(tags.map((t) => t.toLowerCase()));
  const options = suggestions.filter((s) => !lowered.has(s.toLowerCase())).slice(0, 50);
  const off = disabled || busy;

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded-full bg-sunken border border-line px-2 py-0.5 text-xs font-medium text-ink"
        >
          {t}
          <button
            type="button"
            disabled={off}
            onClick={() => void save(tags.filter((x) => x !== t))}
            aria-label={`Remove tag ${t}`}
            className="rounded-full p-0.5 text-muted hover:text-red-600 disabled:opacity-50"
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={value}
        disabled={off}
        list={options.length ? listId : undefined}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Backspace' && !value && tags.length) {
            void save(tags.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={placeholder}
        aria-label={label}
        className="min-w-[7rem] flex-1 rounded-full border border-dashed border-line bg-transparent px-2.5 py-0.5 text-xs text-ink placeholder:text-muted focus:border-brand-500 focus:outline-none disabled:opacity-60"
      />
      {options.length > 0 && (
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
    </div>
  );
}
