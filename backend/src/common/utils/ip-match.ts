// IPv4 allow-list matching (exact IP or CIDR range), used by the attendance
// office-network lock. Ported from the SuperAdminIpGuard logic so both share
// one implementation. Non-IPv4 / malformed entries never match.

/** Normalize an IPv4-mapped IPv6 address (::ffff:1.2.3.4 → 1.2.3.4). */
export function normalizeIp(ip: string): string {
  if (!ip) return '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function toLong(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const a = toLong(ip);
  const b = toLong(range);
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~(0xffffffff >>> bits) >>> 0);
  return (a & mask) === (b & mask);
}

/**
 * True if `ip` matches any entry in the comma-separated `csvList` (exact IPs or
 * IPv4 CIDR ranges). An empty/blank list returns false (caller decides whether
 * "no list" means allow-all or deny).
 */
export function ipInAllowlist(ip: string, csvList: string | null | undefined): boolean {
  const norm = normalizeIp(ip);
  const entries = (csvList ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return false;
  return entries.some((e) => (e.includes('/') ? inCidr(norm, e) : e === norm));
}
