/** URL slug: lowercase, non-alnum → '-', trimmed, max 80. */
export function slugify(input: string): string {
  const s = (input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || 'campaign';
}

/**
 * Dedup key for influencer identity, per the chosen policy:
 * normalized phone → '@'instagram → email. Empty string = can't dedup
 * (anonymous submission → no profile).
 */
export function influencerKey(d: {
  phone?: string | null;
  instagram?: string | null;
  email?: string | null;
}): string {
  const phone = (d.phone || '').replace(/\D/g, '');
  if (phone.length >= 7) return `p:${phone}`;
  const ig = (d.instagram || '').trim().toLowerCase().replace(/^@+/, '');
  if (ig) return `i:${ig}`;
  const em = (d.email || '').trim().toLowerCase();
  if (em) return `e:${em}`;
  return '';
}
