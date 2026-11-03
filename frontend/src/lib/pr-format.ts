/**
 * Formatting helpers for the PR module. The public form captures Instagram /
 * TikTok as whatever the influencer pasted — often a full profile URL with
 * tracking junk (`?igsh=…&wa_status_inline=true`). These turn that into a clean
 * `@handle` for display and a tidy profile URL for linking.
 */

/** A clean `@handle` from an Instagram/TikTok URL or an already-bare handle. */
export function socialHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // Bare handle (no slash): "@foo" / "foo".
  if (!s.includes('/')) {
    const h = s.replace(/^@/, '').split('?')[0].trim();
    return h ? `@${h}` : null;
  }

  // URL form → first non-empty path segment.
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (seg) return `@${seg.replace(/^@/, '')}`;
  } catch {
    /* fall through to the loose parse below */
  }

  const seg = s
    .split('?')[0]
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
    .pop();
  return seg ? `@${seg.replace(/^@/, '')}` : null;
}

/** A tidy, query-stripped profile URL safe to use as an `href`. */
export function socialUrl(
  raw: string | null | undefined,
  platform: 'instagram' | 'tiktok',
): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // Full URL → keep origin + first path segment, drop the query.
  if (s.includes('/')) {
    try {
      const u = new URL(s.startsWith('http') ? s : `https://${s}`);
      const seg = u.pathname.split('/').filter(Boolean)[0];
      return `${u.origin}${seg ? `/${seg}` : ''}`;
    } catch {
      /* fall through */
    }
  }

  // Bare handle → build the canonical profile URL.
  const handle = s.replace(/^@/, '').split('?')[0];
  if (!handle) return null;
  return platform === 'tiktok'
    ? `https://www.tiktok.com/@${handle}`
    : `https://www.instagram.com/${handle}`;
}

/** Up-to-two uppercase initials from a name, for the avatar circle. */
export function initials(name: string | null | undefined): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
