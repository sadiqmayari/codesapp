/**
 * A `fetch` wrapper that ALWAYS enforces a hard timeout via AbortController.
 *
 * Why this exists: a courier's HTTP API can accept the TCP connection and then
 * never send a response (overloaded gateway, half-open connection). A bare
 * `fetch()` has no default timeout in Node's undici, so that call hangs FOREVER.
 * A hung call inside a booking job means the job never resolves, the job-queue
 * worker slot is held indefinitely, and — because same-courier bookings are
 * serialized on one lane — that courier's entire lane is stuck until the process
 * restarts. Routing every courier call through here bounds the wait so a stalled
 * courier fails cleanly (→ queue backoff/retry) instead of stranding the lane.
 *
 * Drop-in for the global `fetch` (same (url, init) shape); `timeoutMs` is an
 * optional 3rd arg. On timeout the returned promise rejects with an AbortError,
 * which the adapters treat as a transient failure (retried), never a hang.
 */
export const COURIER_HTTP_TIMEOUT_MS = 30_000;

export async function httpFetch(
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = COURIER_HTTP_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init ?? {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** True when a buffer is a real PDF (starts with the `%PDF-` magic bytes). A
 *  courier that hasn't finished rendering a large loadsheet often returns a 200
 *  with an error/HTML/JSON body instead — this tells a not-ready sheet apart
 *  from a real one so the two-phase loadsheet flow knows to retry. */
export function isPdf(buf: Buffer | undefined | null): boolean {
  return !!buf && buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}
