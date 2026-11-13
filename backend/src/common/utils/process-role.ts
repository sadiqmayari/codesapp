/**
 * Process role (env `APP_ROLE`) — lets the SAME image run as two containers:
 *   - `web`    serves HTTP + Socket.io + Next. Enqueues jobs, never runs them.
 *   - `worker` runs the job-queue poller + every in-process scheduler. No Next.
 *   - `all`    (default / unset) does both — the original single-container mode.
 * Socket events emitted by the worker reach browsers through the Redis
 * adapter (REDIS_URL), so a split deployment MUST set REDIS_URL on both.
 */
export type ProcessRole = 'all' | 'web' | 'worker';

export function processRole(): ProcessRole {
  const r = (process.env.APP_ROLE ?? '').trim().toLowerCase();
  return r === 'web' || r === 'worker' ? r : 'all';
}

/** True when this process should poll jobs and run schedulers. */
export function runsBackground(): boolean {
  return processRole() !== 'web';
}

/** True when this process should mount the Next.js frontend. */
export function servesFrontend(): boolean {
  return processRole() !== 'worker';
}
