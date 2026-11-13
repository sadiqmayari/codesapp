import * as https from 'https';

export interface HttpResult<T> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
}

/** Minimal JSON-over-https helper shared by the ad platform adapters (no deps). */
export function httpJson<T = unknown>(
  method: 'GET' | 'POST',
  urlString: string,
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<HttpResult<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload =
      body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          Accept: 'application/json',
          ...(payload !== undefined && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { raw: raw.slice(0, 500) };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed as T });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request to ${url.hostname} timed out`));
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Offset string ("+05:00") of an IANA zone at a given instant. */
export function zoneOffset(tz: string | null | undefined, at = new Date()): string {
  if (!tz) return '+00:00';
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .reduce<Record<string, number>>((a, x) => {
        if (x.type !== 'literal') a[x.type] = Number(x.value);
        return a;
      }, {});
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const off = Math.round((asUtc - at.getTime()) / 60000);
    const sign = off >= 0 ? '+' : '-';
    const abs = Math.abs(off);
    const pad = (x: number) => String(x).padStart(2, '0');
    const out = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    return /^[+-]\d{2}:\d{2}$/.test(out) ? out : '+00:00';
  } catch {
    return '+00:00';
  }
}
