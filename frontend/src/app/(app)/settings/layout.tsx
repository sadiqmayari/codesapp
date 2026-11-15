'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight, Search, X } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { cn } from '@/lib/utils';
import { settingsNavFor, type SettingsNavItem } from '@/components/settings/nav';

/**
 * Settings shell: a grouped sub-nav (desktop: left column with search;
 * mobile: horizontal chip bar) + ONE content column. The nav comes from
 * `components/settings/nav.ts` — the same list that gates `[section]`.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname() ?? '';
  const active = pathname.split('/')[2] ?? '';
  const groups = useMemo(() => settingsNavFor(user?.role), [user?.role]);
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const mobileRef = useRef<HTMLDivElement>(null);

  // "/" focuses settings search (when not typing elsewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep the active chip visible in the mobile bar.
  useEffect(() => {
    mobileRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [active]);

  const query = q.trim().toLowerCase();
  const match = (i: SettingsNavItem) =>
    !query || `${i.label} ${i.keywords}`.toLowerCase().includes(query);
  const filtered = groups
    .map((g) => ({ ...g, items: g.items.filter(match) }))
    .filter((g) => g.items.length > 0);
  const flat = groups.flatMap((g) => g.items).filter((i) => !i.href);

  const itemHref = (i: SettingsNavItem) => i.href ?? `/settings/${i.id}`;

  return (
    <div className="min-h-full">
      {/* Mobile: section chips */}
      <div
        ref={mobileRef}
        className="sticky top-0 z-20 flex gap-2 overflow-x-auto border-b border-line bg-surface px-4 py-2.5 md:hidden"
        aria-label="Settings sections"
      >
        {flat.map((i) => (
          <Link
            key={i.id}
            href={itemHref(i)}
            aria-current={active === i.id ? 'page' : undefined}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1.5 text-[13px] font-semibold',
              active === i.id
                ? 'border-transparent bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300'
                : 'border-line text-ink',
            )}
          >
            {i.label}
          </Link>
        ))}
      </div>

      <div className="mx-auto flex max-w-[1180px] gap-8 px-4 py-5 sm:px-6 md:py-7">
        {/* Desktop: grouped nav */}
        <aside className="hidden w-60 shrink-0 md:block">
          <div className="sticky top-4 flex max-h-[calc(100dvh-6rem)] flex-col overflow-y-auto pb-6">
            <p className="px-2.5 pb-3 text-lg font-extrabold text-ink">Settings</p>
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-line bg-sunken px-2.5 py-2">
              <Search size={15} className="shrink-0 text-muted" />
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search settings"
                aria-label="Search settings"
                className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
                onKeyDown={(e) => e.key === 'Escape' && setQ('')}
              />
              {q ? (
                <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="text-muted hover:text-ink">
                  <X size={14} />
                </button>
              ) : (
                <kbd className="rounded border border-line bg-surface px-1.5 text-[11px] text-muted">/</kbd>
              )}
            </div>
            <nav aria-label="Settings">
              {filtered.length === 0 && (
                <p className="px-2.5 py-3 text-sm text-muted">No settings match “{q}”.</p>
              )}
              {filtered.map((g) => (
                <div key={g.label}>
                  <p className="px-2.5 pb-1.5 pt-4 text-[11px] font-bold uppercase tracking-wider text-muted">
                    {g.label}
                  </p>
                  {g.items.map((i) => {
                    const Icon = i.icon;
                    const on = active === i.id;
                    return (
                      <Link
                        key={i.id}
                        href={itemHref(i)}
                        aria-current={on ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-sm',
                          on
                            ? 'bg-brand-50 font-bold text-brand-700 dark:bg-brand-900/40 dark:text-brand-300'
                            : 'font-medium text-ink hover:bg-sunken',
                        )}
                      >
                        <Icon size={17} className={cn('shrink-0', on ? '' : 'text-muted')} />
                        <span className="min-w-0 flex-1 truncate">{i.label}</span>
                        {i.href && <ArrowUpRight size={14} className="shrink-0 text-muted" aria-label="opens another page" />}
                      </Link>
                    );
                  })}
                </div>
              ))}
            </nav>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-[820px] pb-28">{children}</div>
        </main>
      </div>
    </div>
  );
}
