// IP allow-list matching (exact IPv4/IPv6 or IPv4 CIDR), used by the attendance
// office-network lock, plus `clientIp()` — the ONE way to read the caller's real
// IP behind Cloudflare → Traefik. Malformed entries never match.
import type { Request } from 'express';

/** Normalize an IPv4-mapped IPv6 address (::ffff:1.2.3.4 → 1.2.3.4) + lowercase. */
export function normalizeIp(ip: string): string {
  if (!ip) return '';
  const t = ip.trim().toLowerCase();
  return t.startsWith('::ffff:') && t.includes('.') ? t.slice(7) : t;
}

function toLong(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  if (!/^\d{1,2}$/.test(bitsStr ?? '')) return false;
  const bits = Number(bitsStr);
  const a = toLong(ip);
  const b = toLong(range);
  if (a === null || b === null || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : ~(0xffffffff >>> bits) >>> 0;
  return (a & mask) === (b & mask);
}

/** Expand an IPv6 address to 8 groups for exact comparison (null if invalid). */
function expandV6(ip: string): string | null {
  if (!ip.includes(':') || !/^[0-9a-f:]+$/.test(ip)) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => g.length > 4)) return null;
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

function sameIp(a: string, b: string): boolean {
  if (a === b) return true;
  const ea = expandV6(a);
  const eb = expandV6(b);
  return !!ea && ea === eb;
}

/**
 * True if `ip` matches any entry in the comma-separated `csvList` (exact IPv4/IPv6
 * or IPv4 CIDR). An empty list returns false (caller decides what "no list" means).
 */
export function ipInAllowlist(ip: string, csvList: string | null | undefined): boolean {
  const norm = normalizeIp(ip);
  if (!norm) return false;
  const entries = (csvList ?? '')
    .split(/[,\s]+/)
    .map((s) => normalizeIp(s))
    .filter(Boolean);
  if (entries.length === 0) return false;
  return entries.some((e) => (e.includes('/') ? inCidr(norm, e) : sameIp(norm, e)));
}

// Cloudflare edge ranges (https://www.cloudflare.com/ips/). Only when the hop
// that reached our proxy is one of these do we believe CF-Connecting-IP.
const CF_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CF_V6_PREFIX = ['2400:cb00:', '2606:4700:', '2803:f800:', '2405:b500:', '2405:8100:', '2a06:98c0:', '2c0f:f248:'];

export function isCloudflareIp(ip: string): boolean {
  const n = normalizeIp(ip);
  if (n.includes(':')) return CF_V6_PREFIX.some((p) => n.startsWith(p));
  return CF_V4.some((c) => inCidr(n, c));
}

/**
 * The caller's real IP. The LEFT-most X-Forwarded-For entry is client-supplied
 * and spoofable, so never use it (that is what `req.ip` with `trust proxy: true`
 * returns). The RIGHT-most entry was added by our own proxy (Traefik) and is the
 * TCP peer it saw: if that peer is Cloudflare, Cloudflare's CF-Connecting-IP is
 * trustworthy; otherwise the peer itself is the client.
 */
export function clientIp(req: Request): string {
  const xff = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const peer = normalizeIp(xff.length ? xff[xff.length - 1] : req.socket?.remoteAddress ?? '');
  const cf = normalizeIp(String(req.headers['cf-connecting-ip'] ?? ''));
  if (cf && peer && isCloudflareIp(peer)) return cf;
  return peer || normalizeIp(req.ip ?? '');
}
