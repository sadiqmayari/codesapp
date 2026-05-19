import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { CacheService } from '../../common/services/cache.service';

/**
 * Shell-Polish-C: OpenGraph preview fetcher.
 *
 * Best-effort, like the FE-2d reply-context path: a fetch failure / timeout /
 * block NEVER throws and NEVER 5xxes the caller. Only the *initial* user URL
 * being missing / malformed / blocked-scheme / blocked-host throws a 400.
 * Every transport failure (timeout, non-html, oversize, redirect-to-private,
 * too many hops, parse miss) resolves as `{ ok:false, ... }` with all OG
 * fields null. Successes cache 24h, structured failures cache 1h (long enough
 * to stop retry storms, short enough to recover from transient errors).
 *
 * SSRF: native https only (no axios/undici). The host is validated (scheme,
 * literal-IP range, DNS-resolved IP range, localhost) BEFORE every connect,
 * and re-validated on every redirect hop. 5s total deadline, 1MB body cap,
 * max 3 redirect hops.
 */

const FETCH_DEADLINE_MS = 5000;
const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const PARSE_WINDOW_BYTES = 64 * 1024; // OG tags live in <head>
const MAX_REDIRECTS = 3;
const STR_CAP = 300;
const OK_TTL = 86400; // 24h
const FAIL_TTL = 3600; // 1h

export interface OgData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
  fetched_at: string;
  ok: boolean;
}

type RawResponse =
  | {
      kind: 'response';
      statusCode: number;
      contentType: string;
      body: Buffer;
    }
  | { kind: 'redirect'; location: string }
  | { kind: 'oversize' }
  | { kind: 'timeout' }
  | { kind: 'error' };

@Injectable()
export class OgService {
  private readonly logger = new Logger(OgService.name);

  constructor(private readonly cache: CacheService) {}

  async getPreview(rawUrl?: string): Promise<OgData> {
    if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
      throw new BadRequestException('Missing url parameter');
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      throw new BadRequestException('Malformed URL');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Only http and https URLs are allowed');
    }

    // Initial host validation throws 400. (Redirect hops degrade to ok:false
    // instead — see fetchOg.)
    const blockedReason = await this.hostBlockReason(parsed);
    if (blockedReason) {
      throw new BadRequestException(`Blocked host: ${blockedReason}`);
    }

    const canonical = parsed.toString();
    const cacheKey = `og:${createHash('sha1')
      .update(canonical)
      .digest('hex')
      .slice(0, 16)}`;

    const cached = this.cache.get<OgData>(cacheKey);
    if (cached) return cached;

    const result = await this.fetchOg(parsed);
    this.cache.set(cacheKey, result, result.ok ? OK_TTL : FAIL_TTL);
    return result;
  }

  private miss(url: string): OgData {
    return {
      url,
      title: null,
      description: null,
      image: null,
      site_name: null,
      fetched_at: new Date().toISOString(),
      ok: false,
    };
  }

  private async fetchOg(start: URL): Promise<OgData> {
    let current = start;
    const deadline = Date.now() + FETCH_DEADLINE_MS;

    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return this.miss(current.toString());

        const res = await this.httpRequest(current, remaining);

        if (res.kind === 'redirect') {
          if (hop >= MAX_REDIRECTS) {
            this.logger.warn(
              `OG fetch exceeded ${MAX_REDIRECTS} redirects for ${start.toString()}`,
            );
            return this.miss(current.toString());
          }
          let next: URL;
          try {
            next = new URL(res.location, current);
          } catch {
            return this.miss(current.toString());
          }
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            return this.miss(current.toString());
          }
          const blocked = await this.hostBlockReason(next);
          if (blocked) {
            this.logger.warn(
              `OG redirect to blocked host (${blocked}) from ${start.toString()}`,
            );
            return this.miss(current.toString());
          }
          current = next;
          continue;
        }

        if (
          res.kind === 'oversize' ||
          res.kind === 'timeout' ||
          res.kind === 'error'
        ) {
          this.logger.warn(`OG fetch ${res.kind} for ${start.toString()}`);
          return this.miss(current.toString());
        }

        // res.kind === 'response'
        const ct = res.contentType.toLowerCase();
        if (
          !ct.includes('text/html') &&
          !ct.includes('application/xhtml+xml')
        ) {
          return this.miss(current.toString());
        }

        return this.parse(res.body, current.toString());
      }
      return this.miss(current.toString());
    } catch (err) {
      this.logger.warn(
        `OG fetch unexpected failure for ${start.toString()}: ${
          (err as Error)?.message ?? err
        }`,
      );
      return this.miss(current.toString());
    }
  }

  // --- SSRF host validation -------------------------------------------------

  /** Returns a reason string when the host must be blocked, else null. */
  protected async hostBlockReason(u: URL): Promise<string | null> {
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    if (
      host === 'localhost' ||
      host === 'localhost.localdomain' ||
      host.endsWith('.localhost')
    ) {
      return 'localhost';
    }

    const ipVer = net.isIP(host);
    if (ipVer !== 0) {
      return this.isBlockedIp(host) ? `private ip ${host}` : null;
    }

    let addrs: string[];
    try {
      addrs = await this.resolveAddresses(host);
    } catch {
      // DNS failure — let the fetch attempt fail as ok:false rather than 400.
      return null;
    }
    if (!addrs.length) return null;
    for (const a of addrs) {
      if (this.isBlockedIp(a)) return `resolves to private ip ${a}`;
    }
    return null;
  }

  /** Seam for tests — real DNS resolution of every A/AAAA record. */
  protected async resolveAddresses(host: string): Promise<string[]> {
    const recs = await dnsLookup(host, { all: true });
    return recs.map((r) => r.address);
  }

  private isBlockedIp(ip: string): boolean {
    const ver = net.isIP(ip);
    if (ver === 4) return this.isBlockedV4(ip);
    if (ver === 6) return this.isBlockedV6(ip);
    return true; // unknown shape — fail closed
  }

  private isBlockedV4(ip: string): boolean {
    const o = ip.split('.').map((x) => parseInt(x, 10));
    if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = o;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 multicast
    if (a >= 240) return true; // 240.0.0.0/4 reserved
    return false;
  }

  private isBlockedV6(ip: string): boolean {
    const lower = ip.toLowerCase();
    // IPv4-mapped / -compatible — validate the embedded v4.
    const mapped = lower.match(/(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/);
    if (mapped) return this.isBlockedV4(mapped[1]);

    if (lower === '::1' || lower === '::') return true; // loopback / unspecified

    const head = lower.split(':')[0] ?? '';
    const hv = parseInt(head, 16);
    if (!Number.isNaN(hv)) {
      if ((hv & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
      if ((hv & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    }
    return false;
  }

  // --- HTTP (native, manual redirects) -------------------------------------

  /** Seam for tests — performs ONE request, no auto-redirect. */
  protected httpRequest(u: URL, timeoutMs: number): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve) => {
      const client = u.protocol === 'https:' ? https : http;
      let settled = false;
      const done = (r: RawResponse) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      const req = client.request(
        u,
        {
          method: 'GET',
          timeout: timeoutMs,
          headers: {
            'User-Agent': 'CodesAppBot/1.0 (+https://apps.codentra.pk)',
            Accept: 'text/html,application/xhtml+xml',
          },
          // No keep-alive: one-shot fetch.
          agent: false,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          const loc = res.headers.location;
          if (
            status >= 300 &&
            status < 400 &&
            typeof loc === 'string' &&
            loc
          ) {
            res.destroy();
            done({ kind: 'redirect', location: loc });
            return;
          }

          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
              res.destroy();
              done({ kind: 'oversize' });
              return;
            }
            chunks.push(c);
          });
          res.on('end', () =>
            done({
              kind: 'response',
              statusCode: status,
              contentType: String(res.headers['content-type'] ?? ''),
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', () => done({ kind: 'error' }));
        },
      );

      req.on('timeout', () => {
        req.destroy();
        done({ kind: 'timeout' });
      });
      req.on('error', () => done({ kind: 'error' }));
      req.end();
    });
  }

  // --- Parsing (regex only, no HTML parser) --------------------------------

  private parse(body: Buffer, finalUrl: string): OgData {
    const head = body.subarray(0, PARSE_WINDOW_BYTES).toString('utf8');

    const og = (key: string) => this.metaByAttr(head, 'property', key);
    const nameMeta = (key: string) => this.metaByAttr(head, 'name', key);

    let title = og('og:title');
    if (!title) {
      const t = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = t ? t[1] : null;
    }

    let description = og('og:description');
    if (!description) description = nameMeta('description');

    let image = og('og:image');
    if (image) {
      try {
        image = new URL(image, finalUrl).toString();
      } catch {
        image = null;
      }
    }

    const siteName = og('og:site_name');
    const ogUrl = og('og:url');

    let canonical = finalUrl;
    if (ogUrl) {
      try {
        canonical = new URL(ogUrl, finalUrl).toString();
      } catch {
        canonical = finalUrl;
      }
    }

    return {
      url: canonical,
      title: this.clean(title),
      description: this.clean(description),
      image: this.clean(image),
      site_name: this.clean(siteName),
      fetched_at: new Date().toISOString(),
      ok: true,
    };
  }

  /** Find a <meta> tag where `attr` (property|name) === key, return content. */
  private metaByAttr(
    html: string,
    attr: string,
    key: string,
  ): string | null {
    const tags = html.match(/<meta\b[^>]*>/gi);
    if (!tags) return null;
    const wanted = key.toLowerCase();
    for (const tag of tags) {
      const a = this.attrValue(tag, attr);
      if (a !== null && a.toLowerCase() === wanted) {
        const content = this.attrValue(tag, 'content');
        if (content !== null) return content;
      }
    }
    return null;
  }

  private attrValue(tag: string, attr: string): string | null {
    const re = new RegExp(
      `\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
      'i',
    );
    const m = tag.match(re);
    if (!m) return null;
    return m[2] ?? m[3] ?? m[4] ?? '';
  }

  private clean(s: string | null): string | null {
    if (s == null) return null;
    const decoded = this.decodeEntities(s);
    let out = '';
    for (const ch of decoded) {
      const code = ch.charCodeAt(0);
      // drop C0 controls + DEL; keep tab/newline as space via \s collapse
      if (code < 0x20 || code === 0x7f) {
        out += ' ';
      } else {
        out += ch;
      }
    }
    out = out.replace(/\s+/g, ' ').trim();
    if (!out) return null;
    if (out.length > STR_CAP) out = out.slice(0, STR_CAP);
    return out;
  }

  private decodeEntities(s: string): string {
    return s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/&#x0*27;/gi, "'")
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&');
  }
}
