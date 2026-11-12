'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Hash,
  Loader2,
  MessagesSquare,
  Plus,
  Search,
  User as UserIcon,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/auth-context';
import type { ConversationRow } from '@/lib/inbox-types';
import { flatNav, hasInbox } from './nav-config';

/**
 * Global command palette (UI Phase B). Ctrl/⌘+K anywhere in the app, or the
 * navbar search button. Searches pages (role-gated via nav-config), quick
 * actions, live chats + contacts (inbox roles only), and jumps to an order by
 * number. Purely navigational — it never mutates anything.
 */

interface Cmd {
  key: string;
  group: 'Chats' | 'Contacts' | 'Orders' | 'Actions' | 'Pages';
  label: string;
  hint?: string;
  icon: React.ElementType;
  href: string;
}

const PaletteCtx = createContext<{ open: () => void }>({ open: () => {} });
export const useCommandPalette = () => useContext(PaletteCtx);

interface ContactLite {
  id: number;
  name: string | null;
  phone: string;
}

export function CommandPaletteProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isOpen, setOpen] = useState(false);
  const open = useCallback(() => setOpen(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <PaletteCtx.Provider value={{ open }}>
      {children}
      {isOpen && <Palette onClose={() => setOpen(false)} />}
    </PaletteCtx.Provider>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { user } = useAuth();
  const inbox = hasInbox(user);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [chats, setChats] = useState<ConversationRow[]>([]);
  const [contacts, setContacts] = useState<ContactLite[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Live chat + contact search (debounced, inbox roles only).
  useEffect(() => {
    const term = q.trim();
    if (!inbox || term.length < 2) {
      setChats([]);
      setContacts([]);
      setSearching(false);
      return;
    }
    let alive = true;
    setSearching(true);
    const t = setTimeout(async () => {
      const [c, k] = await Promise.allSettled([
        apiFetch<ConversationRow[]>('/inbox/conversations', {
          params: { search: term, status: 'all', limit: 5 },
          noOnboardingRedirect: true,
        }),
        apiFetch<ContactLite[] | { items?: ContactLite[]; data?: ContactLite[] }>(
          '/contacts',
          { params: { search: term, limit: 5 }, noOnboardingRedirect: true },
        ),
      ]);
      if (!alive) return;
      setChats(c.status === 'fulfilled' && Array.isArray(c.value) ? c.value : []);
      if (k.status === 'fulfilled') {
        const v = k.value;
        const arr = Array.isArray(v) ? v : v?.items ?? v?.data ?? [];
        setContacts(Array.isArray(arr) ? arr.slice(0, 5) : []);
      } else setContacts([]);
      setSearching(false);
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, inbox]);

  const cmds = useMemo<Cmd[]>(() => {
    const term = q.trim().toLowerCase();
    const nav = flatNav(user);
    const navHrefs = new Set(nav.map((n) => n.href));
    const out: Cmd[] = [];

    const orderNo = term.replace(/^#/, '');
    if (/^\d{3,}$/.test(orderNo) && navHrefs.has('/orders')) {
      out.push({
        key: `order:${orderNo}`,
        group: 'Orders',
        label: `Open order #${orderNo}`,
        icon: Hash,
        href: `/orders/${orderNo}`,
      });
    }

    for (const c of chats) {
      out.push({
        key: `chat:${c.id}`,
        group: 'Chats',
        label: c.contact?.name || c.contact?.phone || 'Unknown',
        hint: c.last_message ?? c.contact?.phone ?? undefined,
        icon: MessagesSquare,
        href: `/inbox/${c.id}`,
      });
    }
    for (const c of contacts) {
      out.push({
        key: `contact:${c.id}`,
        group: 'Contacts',
        label: c.name || c.phone,
        hint: c.name ? c.phone : undefined,
        icon: UserIcon,
        href: `/contacts/${c.id}`,
      });
    }

    const actions: Cmd[] = [
      navHrefs.has('/broadcasts') && {
        key: 'a:broadcast',
        group: 'Actions' as const,
        label: 'New broadcast',
        icon: Plus,
        href: '/broadcasts/new',
      },
      navHrefs.has('/orders') && {
        key: 'a:book',
        group: 'Actions' as const,
        label: 'Book confirmed orders',
        hint: 'Orders → To book',
        icon: ArrowRight,
        href: '/orders/fulfillment',
      },
      navHrefs.has('/team-chat') && {
        key: 'a:checkin',
        group: 'Actions' as const,
        label: 'Check in / attendance',
        icon: ArrowRight,
        href: '/team-chat',
      },
      navHrefs.has('/settings') && {
        key: 'a:profile',
        group: 'Actions' as const,
        label: 'Change my password',
        hint: 'Settings → Security',
        icon: ArrowRight,
        href: '/settings',
      },
    ].filter(Boolean) as Cmd[];

    const pages: Cmd[] = nav.map((n) => ({
      key: `p:${n.href}`,
      group: 'Pages',
      label: n.label,
      icon: n.icon,
      href: n.href,
    }));

    const match = (c: Cmd) =>
      !term ||
      c.label.toLowerCase().includes(term) ||
      (c.hint ?? '').toLowerCase().includes(term);

    return [...out, ...actions.filter(match), ...pages.filter(match)];
  }, [q, chats, contacts, user]);

  useEffect(() => {
    setSel((s) => (s >= cmds.length ? 0 : s));
  }, [cmds.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const go = (c: Cmd | undefined) => {
    if (!c) return;
    onClose();
    router.push(c.href);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, cmds.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(cmds[sel]);
    }
  };

  let lastGroup = '';
  return (
    <div
      className="fixed inset-0 z-[95] bg-black/40 flex items-start justify-center p-3 pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search and jump"
        onKeyDown={onKey}
        className="w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden"
      >
        <div className="flex items-center gap-3 px-4 h-14 border-b border-gray-100">
          <Search size={18} className="text-gray-400 shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            placeholder={
              inbox
                ? 'Search chats, contacts, order #, pages…'
                : 'Search pages and actions…'
            }
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={cmds[sel] ? `cmdk-${sel}` : undefined}
            className="flex-1 bg-transparent outline-none text-[15px] text-gray-900 placeholder:text-gray-400"
          />
          {searching && <Loader2 size={16} className="animate-spin text-gray-400" />}
          <kbd className="hidden sm:inline text-xs font-semibold text-gray-400 border border-gray-200 rounded px-1.5 py-0.5">
            Esc
          </kbd>
        </div>
        <ul
          id="cmdk-list"
          ref={listRef}
          role="listbox"
          className="max-h-[60vh] overflow-y-auto p-2"
        >
          {cmds.length === 0 ? (
            <li className="px-4 py-10 text-center text-sm text-gray-500">
              {searching ? 'Searching…' : 'No matches. Try a name, phone, or order number.'}
            </li>
          ) : (
            cmds.map((c, i) => {
              const header = c.group !== lastGroup ? c.group : null;
              lastGroup = c.group;
              const Icon = c.icon;
              return (
                <li key={c.key} role="presentation">
                  {header && (
                    <p className="px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
                      {header}
                    </p>
                  )}
                  <div
                    id={`cmdk-${i}`}
                    data-idx={i}
                    role="option"
                    aria-selected={i === sel}
                    onMouseMove={() => i !== sel && setSel(i)}
                    onClick={() => go(c)}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-sm',
                      i === sel ? 'bg-brand-50 text-brand-800' : 'text-gray-700',
                    )}
                  >
                    <Icon size={16} className="shrink-0 opacity-70" />
                    <span className="font-medium truncate">{c.label}</span>
                    {c.hint && (
                      <span className="text-xs text-gray-500 truncate">{c.hint}</span>
                    )}
                    {i === sel && (
                      <kbd className="ml-auto hidden sm:inline text-xs text-gray-400">
                        Enter
                      </kbd>
                    )}
                  </div>
                </li>
              );
            })
          )}
        </ul>
        <div className="hidden sm:flex gap-4 px-4 py-2 border-t border-gray-100 text-xs text-gray-400">
          <span>↑↓ to move</span>
          <span>Enter to open</span>
          <span>Ctrl/⌘ K to toggle</span>
        </div>
      </div>
    </div>
  );
}
