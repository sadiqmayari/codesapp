'use client';

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Package, ChevronDown, Mail, MapPin, Phone, ShoppingBag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchVariantImages } from '@/lib/couriers';

/**
 * Shopify-style hover popovers for the Orders queue rows. Both are
 * fixed-positioned (anchored to the trigger via getBoundingClientRect) so the
 * table's horizontal scroll container can't clip them. Hover-driven: the popover
 * is a DOM child of the wrapper, so moving the cursor onto it doesn't trip the
 * wrapper's onMouseLeave.
 */
function useAnchor() {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [open, setOpen] = useState(false);
  const show = () => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 6, left: rect.left });
    setOpen(true);
  };
  const hide = () => setOpen(false);
  return { ref, pos, open, show, hide };
}

// Module-level cache: ProductVariant gid → image URL (or null once fetched with
// no image). Shared across every row/popover so images resolve once per session.
const imageCache = new Map<string, string | null>();

export interface QueueItem {
  title: string | null;
  quantity: number;
  variantTitle?: string | null;
  variantId?: string | null;
}

/** "N items ▾" chip → popover with the fulfilment badge + each line item. */
export function ItemsPopover({
  items,
  count,
  fulfillmentStatus,
  trailing,
}: {
  items: QueueItem[];
  count: number;
  fulfillmentStatus: string | null;
  /** Extra control rendered next to the chip (e.g. the edit-items pencil). */
  trailing?: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [, force] = useState(0);
  const unfulfilled = (fulfillmentStatus ?? 'unfulfilled') === 'unfulfilled';

  // Click to toggle (a chevron = a dropdown, not a hover card). Close on an
  // outside click, or on scroll/resize (the fixed popover would otherwise drift).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, left: rect.left });
    setOpen(true);
    // Lazy-load thumbnails for any variant we haven't resolved yet.
    const need = Array.from(
      new Set(
        items
          .map((i) => i.variantId)
          .filter((v): v is string => !!v && !imageCache.has(v)),
      ),
    );
    if (!need.length) return;
    fetchVariantImages(need)
      .then((map) => {
        need.forEach((v) => imageCache.set(v, map[v] ?? null));
        force((n) => n + 1);
      })
      .catch(() => need.forEach((v) => imageCache.set(v, null)));
  };

  return (
    <span ref={ref} className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={toggle}
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-gray-700 hover:bg-gray-100',
          open && 'bg-gray-100',
        )}
      >
        {count ? `${count} item${count === 1 ? '' : 's'}` : '—'}
        {count > 0 && (
          <ChevronDown
            size={13}
            className={cn('text-gray-400 transition-transform', open && 'rotate-180')}
          />
        )}
      </button>
      {trailing}
      {open && pos && count > 0 && (
        <div
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-50 w-72 rounded-xl border border-gray-200 bg-white p-3 shadow-xl"
        >
          <span
            className={cn(
              'mb-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
              unfulfilled ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700',
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                unfulfilled ? 'bg-amber-500' : 'bg-emerald-500',
              )}
            />
            {unfulfilled ? 'Unfulfilled' : (fulfillmentStatus ?? 'Fulfilled')}
          </span>
          <ul className="space-y-2">
            {items.map((it, i) => {
              const url = it.variantId ? imageCache.get(it.variantId) : null;
              return (
                <li key={i} className="flex items-start gap-2">
                  {url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={url}
                      alt=""
                      className="mt-0.5 h-9 w-9 shrink-0 rounded-md border border-gray-200 object-cover"
                    />
                  ) : (
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-gray-50 text-gray-400">
                      <Package size={16} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-gray-800" title={it.title ?? ''}>
                      {it.title ?? 'Item'}
                    </p>
                    {it.variantTitle && (
                      <p className="truncate text-[11px] text-gray-500">{it.variantTitle}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-gray-500">× {it.quantity}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </span>
  );
}

/** Customer name → popover with order count, destination, phone, email. */
export function CustomerPopover({
  name,
  phone,
  email,
  city,
  address,
  ordersCount,
}: {
  name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  address: string | null;
  ordersCount: number | null;
}) {
  const { ref, pos, open, show, hide } = useAnchor();
  return (
    <span ref={ref} onMouseEnter={show} onMouseLeave={hide} className="inline-block">
      <button type="button" className="text-left text-gray-800 hover:text-gray-900 hover:underline">
        {name || '—'}
      </button>
      {open && pos && (
        <div
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-50 w-72 rounded-xl border border-gray-200 bg-white p-3 text-xs shadow-xl"
        >
          <p className="mb-1 text-sm font-semibold text-gray-900">{name || 'Customer'}</p>
          {(city || address) && (
            <p className="mb-1.5 flex items-start gap-1.5 text-gray-600">
              <MapPin size={13} className="mt-0.5 shrink-0 text-gray-400" />
              <span className="whitespace-normal break-words">
                {[address, city].filter(Boolean).join(', ')}
              </span>
            </p>
          )}
          {ordersCount != null && (
            <p className="mb-1 flex items-center gap-1.5 text-gray-600">
              <ShoppingBag size={13} className="shrink-0 text-gray-400" />
              {ordersCount} order{ordersCount === 1 ? '' : 's'}
            </p>
          )}
          {phone && (
            <p className="mb-1 flex items-center gap-1.5 text-gray-600">
              <Phone size={13} className="shrink-0 text-gray-400" />
              <a href={`tel:${phone}`} className="hover:underline">
                {phone}
              </a>
            </p>
          )}
          {email && (
            <p className="flex items-center gap-1.5 text-blue-700">
              <Mail size={13} className="shrink-0 text-blue-400" />
              <a href={`mailto:${email}`} className="truncate hover:underline" title={email}>
                {email}
              </a>
            </p>
          )}
          {!phone && !email && !city && !address && (
            <p className="text-gray-400">No contact details on file.</p>
          )}
        </div>
      )}
    </span>
  );
}
