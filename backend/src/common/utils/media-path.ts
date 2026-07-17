import * as path from 'path';

/**
 * How long downloaded/sent WhatsApp media is kept on local disk before the
 * cleanup cron purges it. Tenants asked for 14 days (was 7). Single source of
 * truth — every `media_expires_at` write uses this. NOTE: doubling retention
 * ~doubles steady-state media disk usage.
 */
export const MEDIA_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Map a `/storage/...` WEB path (as stored in `messages.media_url`) to its real
 * absolute path on disk. Files live under `<cwd>/../storage/...`; the DB only
 * ever holds the web path (FE-2c convention). Guarded to stay INSIDE the storage
 * root — returns null for a malformed or escaping path so callers never unlink /
 * read outside storage.
 *
 * This exists because the media-cleanup cron previously called
 * `fs.unlink(media_url)` on the raw web path (`/storage/media/...`), which
 * resolves from filesystem root, always ENOENTs, and so NEVER deleted anything —
 * media accumulated forever. Both the cleanup cron and the outbound media
 * pipeline resolve real paths through here.
 */
export function mediaWebPathToDisk(webPath: string): string | null {
  if (typeof webPath !== 'string' || !webPath.startsWith('/storage/')) return null;
  const storageBase = path.resolve(path.join(process.cwd(), '..', 'storage'));
  const abs = path.resolve(
    path.join(process.cwd(), '..', webPath.replace(/^\/+/, '')),
  );
  if (abs !== storageBase && !abs.startsWith(storageBase + path.sep)) return null;
  return abs;
}
