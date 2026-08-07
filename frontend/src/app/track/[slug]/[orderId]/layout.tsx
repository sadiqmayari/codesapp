import type { Metadata } from 'next';
import { headers } from 'next/headers';

/**
 * Server component wrapping the (client) tracking page so we can set a
 * per-tenant favicon + title from the slug. The client page can't export
 * `generateMetadata`, and the parent `track/layout.tsx` doesn't receive the
 * `[slug]` param — so this per-order layout owns the branded metadata.
 *
 * The tenant logo (`/storage/branding/...`, served on the same host for both
 * `apps.` and `track.`) becomes the browser-tab icon; falls back to the app's
 * default `icon.svg` when the tenant has no logo or the lookup fails.
 */
export async function generateMetadata({
  params,
}: {
  params: { slug: string; orderId: string };
}): Promise<Metadata> {
  const fallback: Metadata = { title: 'Order tracking' };
  try {
    const h = headers();
    const host = h.get('x-forwarded-host') ?? h.get('host');
    if (!host) return fallback;
    const proto = h.get('x-forwarded-proto') ?? 'https';
    const res = await fetch(
      `${proto}://${host}/api/public/track/${encodeURIComponent(params.slug)}/brand`,
      { cache: 'no-store' },
    );
    if (!res.ok) return fallback;
    const body = await res.json().catch(() => null);
    const brand = body?.data ?? body;
    const name: string | undefined = brand?.name;
    const logo: string | null | undefined = brand?.logo_url;
    const meta: Metadata = { title: name ? `${name} — Order tracking` : 'Order tracking' };
    if (logo) meta.icons = { icon: logo, shortcut: logo, apple: logo };
    return meta;
  } catch {
    return fallback;
  }
}

export default function TrackOrderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
