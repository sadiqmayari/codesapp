"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var OgService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OgService = void 0;
const common_1 = require("@nestjs/common");
const node_crypto_1 = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const promises_1 = require("node:dns/promises");
const cache_service_1 = require("../../common/services/cache.service");
const FETCH_DEADLINE_MS = 5000;
const MAX_BODY_BYTES = 1024 * 1024;
const PARSE_WINDOW_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const STR_CAP = 300;
const OK_TTL = 86400;
const FAIL_TTL = 3600;
let OgService = OgService_1 = class OgService {
    constructor(cache) {
        this.cache = cache;
        this.logger = new common_1.Logger(OgService_1.name);
    }
    async getPreview(rawUrl) {
        if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
            throw new common_1.BadRequestException('Missing url parameter');
        }
        let parsed;
        try {
            parsed = new URL(rawUrl.trim());
        }
        catch {
            throw new common_1.BadRequestException('Malformed URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new common_1.BadRequestException('Only http and https URLs are allowed');
        }
        const blockedReason = await this.hostBlockReason(parsed);
        if (blockedReason) {
            throw new common_1.BadRequestException(`Blocked host: ${blockedReason}`);
        }
        const canonical = parsed.toString();
        const cacheKey = `og:${(0, node_crypto_1.createHash)('sha1')
            .update(canonical)
            .digest('hex')
            .slice(0, 16)}`;
        const cached = this.cache.get(cacheKey);
        if (cached)
            return cached;
        const result = await this.fetchOg(parsed);
        this.cache.set(cacheKey, result, result.ok ? OK_TTL : FAIL_TTL);
        return result;
    }
    miss(url) {
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
    async fetchOg(start) {
        let current = start;
        const deadline = Date.now() + FETCH_DEADLINE_MS;
        try {
            for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
                const remaining = deadline - Date.now();
                if (remaining <= 0)
                    return this.miss(current.toString());
                const res = await this.httpRequest(current, remaining);
                if (res.kind === 'redirect') {
                    if (hop >= MAX_REDIRECTS) {
                        this.logger.warn(`OG fetch exceeded ${MAX_REDIRECTS} redirects for ${start.toString()}`);
                        return this.miss(current.toString());
                    }
                    let next;
                    try {
                        next = new URL(res.location, current);
                    }
                    catch {
                        return this.miss(current.toString());
                    }
                    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
                        return this.miss(current.toString());
                    }
                    const blocked = await this.hostBlockReason(next);
                    if (blocked) {
                        this.logger.warn(`OG redirect to blocked host (${blocked}) from ${start.toString()}`);
                        return this.miss(current.toString());
                    }
                    current = next;
                    continue;
                }
                if (res.kind === 'oversize' ||
                    res.kind === 'timeout' ||
                    res.kind === 'error') {
                    this.logger.warn(`OG fetch ${res.kind} for ${start.toString()}`);
                    return this.miss(current.toString());
                }
                const ct = res.contentType.toLowerCase();
                if (!ct.includes('text/html') &&
                    !ct.includes('application/xhtml+xml')) {
                    return this.miss(current.toString());
                }
                return this.parse(res.body, current.toString());
            }
            return this.miss(current.toString());
        }
        catch (err) {
            this.logger.warn(`OG fetch unexpected failure for ${start.toString()}: ${err?.message ?? err}`);
            return this.miss(current.toString());
        }
    }
    async hostBlockReason(u) {
        const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (host === 'localhost' ||
            host === 'localhost.localdomain' ||
            host.endsWith('.localhost')) {
            return 'localhost';
        }
        const ipVer = net.isIP(host);
        if (ipVer !== 0) {
            return this.isBlockedIp(host) ? `private ip ${host}` : null;
        }
        let addrs;
        try {
            addrs = await this.resolveAddresses(host);
        }
        catch {
            return null;
        }
        if (!addrs.length)
            return null;
        for (const a of addrs) {
            if (this.isBlockedIp(a))
                return `resolves to private ip ${a}`;
        }
        return null;
    }
    async resolveAddresses(host) {
        const recs = await (0, promises_1.lookup)(host, { all: true });
        return recs.map((r) => r.address);
    }
    isBlockedIp(ip) {
        const ver = net.isIP(ip);
        if (ver === 4)
            return this.isBlockedV4(ip);
        if (ver === 6)
            return this.isBlockedV6(ip);
        return true;
    }
    isBlockedV4(ip) {
        const o = ip.split('.').map((x) => parseInt(x, 10));
        if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
            return true;
        }
        const [a, b] = o;
        if (a === 0)
            return true;
        if (a === 127)
            return true;
        if (a === 10)
            return true;
        if (a === 172 && b >= 16 && b <= 31)
            return true;
        if (a === 192 && b === 168)
            return true;
        if (a === 169 && b === 254)
            return true;
        if (a >= 224 && a <= 239)
            return true;
        if (a >= 240)
            return true;
        return false;
    }
    isBlockedV6(ip) {
        const lower = ip.toLowerCase();
        const mapped = lower.match(/(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/);
        if (mapped)
            return this.isBlockedV4(mapped[1]);
        if (lower === '::1' || lower === '::')
            return true;
        const head = lower.split(':')[0] ?? '';
        const hv = parseInt(head, 16);
        if (!Number.isNaN(hv)) {
            if ((hv & 0xfe00) === 0xfc00)
                return true;
            if ((hv & 0xffc0) === 0xfe80)
                return true;
        }
        return false;
    }
    httpRequest(u, timeoutMs) {
        return new Promise((resolve) => {
            const client = u.protocol === 'https:' ? https : http;
            let settled = false;
            const done = (r) => {
                if (settled)
                    return;
                settled = true;
                resolve(r);
            };
            const req = client.request(u, {
                method: 'GET',
                timeout: timeoutMs,
                headers: {
                    'User-Agent': 'CodesAppBot/1.0 (+https://apps.codentra.pk)',
                    Accept: 'text/html,application/xhtml+xml',
                },
                agent: false,
            }, (res) => {
                const status = res.statusCode ?? 0;
                const loc = res.headers.location;
                if (status >= 300 &&
                    status < 400 &&
                    typeof loc === 'string' &&
                    loc) {
                    res.destroy();
                    done({ kind: 'redirect', location: loc });
                    return;
                }
                const chunks = [];
                let size = 0;
                res.on('data', (c) => {
                    size += c.length;
                    if (size > MAX_BODY_BYTES) {
                        res.destroy();
                        done({ kind: 'oversize' });
                        return;
                    }
                    chunks.push(c);
                });
                res.on('end', () => done({
                    kind: 'response',
                    statusCode: status,
                    contentType: String(res.headers['content-type'] ?? ''),
                    body: Buffer.concat(chunks),
                }));
                res.on('error', () => done({ kind: 'error' }));
            });
            req.on('timeout', () => {
                req.destroy();
                done({ kind: 'timeout' });
            });
            req.on('error', () => done({ kind: 'error' }));
            req.end();
        });
    }
    parse(body, finalUrl) {
        const head = body.subarray(0, PARSE_WINDOW_BYTES).toString('utf8');
        const og = (key) => this.metaByAttr(head, 'property', key);
        const nameMeta = (key) => this.metaByAttr(head, 'name', key);
        let title = og('og:title');
        if (!title) {
            const t = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            title = t ? t[1] : null;
        }
        let description = og('og:description');
        if (!description)
            description = nameMeta('description');
        let image = og('og:image');
        if (image) {
            try {
                image = new URL(image, finalUrl).toString();
            }
            catch {
                image = null;
            }
        }
        const siteName = og('og:site_name');
        const ogUrl = og('og:url');
        let canonical = finalUrl;
        if (ogUrl) {
            try {
                canonical = new URL(ogUrl, finalUrl).toString();
            }
            catch {
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
    metaByAttr(html, attr, key) {
        const tags = html.match(/<meta\b[^>]*>/gi);
        if (!tags)
            return null;
        const wanted = key.toLowerCase();
        for (const tag of tags) {
            const a = this.attrValue(tag, attr);
            if (a !== null && a.toLowerCase() === wanted) {
                const content = this.attrValue(tag, 'content');
                if (content !== null)
                    return content;
            }
        }
        return null;
    }
    attrValue(tag, attr) {
        const re = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
        const m = tag.match(re);
        if (!m)
            return null;
        return m[2] ?? m[3] ?? m[4] ?? '';
    }
    clean(s) {
        if (s == null)
            return null;
        const decoded = this.decodeEntities(s);
        let out = '';
        for (const ch of decoded) {
            const code = ch.charCodeAt(0);
            if (code < 0x20 || code === 0x7f) {
                out += ' ';
            }
            else {
                out += ch;
            }
        }
        out = out.replace(/\s+/g, ' ').trim();
        if (!out)
            return null;
        if (out.length > STR_CAP)
            out = out.slice(0, STR_CAP);
        return out;
    }
    decodeEntities(s) {
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
};
exports.OgService = OgService;
exports.OgService = OgService = OgService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [cache_service_1.CacheService])
], OgService);
//# sourceMappingURL=og.service.js.map