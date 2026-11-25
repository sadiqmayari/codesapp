// Client-side twin of backend common/utils/ip-match (display only — the server
// decides). Exact IPv4/IPv6 or IPv4 CIDR.
function toLong(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    out = (out << 8) | Number(p);
  }
  return out >>> 0;
}

/** True when `ip` equals `entry` or falls inside an IPv4 CIDR `entry`. */
export function ipMatchesEntry(ip: string, entry: string): boolean {
  const a = ip.trim().toLowerCase();
  const e = entry.trim().toLowerCase();
  if (!a || !e) return false;
  if (!e.includes('/')) return a === e;
  const [range, bitsStr] = e.split('/');
  if (!/^\d{1,2}$/.test(bitsStr ?? '')) return false;
  const bits = Number(bitsStr);
  const x = toLong(a);
  const y = toLong(range);
  if (x === null || y === null || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : ~(0xffffffff >>> bits) >>> 0;
  return (x & mask) === (y & mask);
}
