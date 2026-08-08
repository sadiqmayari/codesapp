'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { searchCities } from '@/lib/couriers';

/**
 * Type-to-filter city input used by the create-order and correct-address
 * forms. Suggestions come from the known courier cities (platform seed +
 * tenant overrides) via `searchCities`, so it's tenant-agnostic — but free
 * text is always allowed (couriers only need a resolvable city at booking,
 * and agents may enter a city we don't have a code for yet).
 *
 * Keyboard: ↑/↓ move, Enter picks, Esc closes. Outside-click closes.
 */
export function CityAutocomplete({
  value,
  onChange,
  invalid = false,
  placeholder = 'Start typing a city…',
  inputClassName,
  autoComplete = 'off',
}: {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  placeholder?: string;
  /** Extra classes on the <input> (e.g. `text-base` for larger address font). */
  inputClassName?: string;
  autoComplete?: string;
}) {
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // Skip the next fetch after we programmatically set the value from a pick.
  const skipRef = useRef(false);

  // Debounced suggestion fetch on value change.
  useEffect(() => {
    if (skipRef.current) {
      skipRef.current = false;
      return;
    }
    const q = value.trim();
    if (q.length < 2) {
      setMatches([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      searchCities(q)
        .then((rows) => {
          if (alive) {
            setMatches(rows);
            setActive(0);
          }
        })
        .catch(() => {
          if (alive) setMatches([]);
        });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value]);

  // Close on outside click.
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const pick = (c: string) => {
    skipRef.current = true;
    onChange(c);
    setOpen(false);
    setMatches([]);
  };

  const showList = open && matches.length > 0;

  return (
    <div ref={boxRef} className="relative">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!showList) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(matches[active]);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        autoComplete={autoComplete}
        placeholder={placeholder}
        className={cn(
          'w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500',
          invalid ? 'border-red-300' : 'border-gray-300',
          inputClassName ?? 'text-sm',
        )}
      />
      {showList && (
        <ul className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-gray-200 bg-white py-1 text-sm shadow-lg">
          {matches.map((c, i) => (
            <li key={c}>
              <button
                type="button"
                // Prevent the input blur from closing the list before click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(c)}
                className={cn(
                  'block w-full px-3 py-1.5 text-left',
                  i === active
                    ? 'bg-green-50 text-green-800'
                    : 'text-gray-700 hover:bg-gray-50',
                )}
              >
                {c}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
