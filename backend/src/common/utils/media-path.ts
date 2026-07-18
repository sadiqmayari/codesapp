import * as path from 'path';
import { Logger } from '@nestjs/common';

const thumbLogger = new Logger('MediaThumbnail');

/**
 * Longest edge (px) of a display thumbnail. The inbox bubble is ~340px and the
 * lightbox loads the full-res original on tap, so 480 covers hi-dpi bubbles
 * while decoding ~50× cheaper than a 10-megapixel phone photo.
 */
const THUMB_MAX_EDGE = 480;

/**
 * Convention (NO DB column — dodges the prod P3009 migration block): a display
 * thumbnail lives next to its original with the extension swapped for
 * `.thumb.jpg`. Both backend (generation) and frontend (URL derivation + <img>
 * onError fallback) compute it the same way, so an original that predates
 * thumbnails simply 404s the thumb and the client shows the full-res file.
 */
export function toThumbPath(p: string): string {
  return p.replace(/\.[^./\\]+$/, '.thumb.jpg');
}

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

/**
 * Generate a small display thumbnail (`<name>.thumb.jpg`) next to an original
 * image so the inbox renders a light bitmap instead of decoding the full-res
 * original on every paint (the "decode-on-paint" jank during the socket
 * re-render storm). NON-THROWING and image-only: on any failure — non-image
 * mime, animated gif, sharp error — it simply does nothing and the client keeps
 * showing the full-res image. Transparency is flattened onto white to match the
 * bubble's white media backing.
 *
 * Runs OFF the request/response path (fire-and-forget at the media-save sites),
 * so the small CPU cost of the resize never delays a send or an inbound emit.
 */
export async function generateImageThumbnail(absPath: string): Promise<void> {
  // Key off the file extension (always present on our saved media) so both the
  // inbound and outbound call sites can just pass the path. JPEG/PNG/WebP only —
  // skip gif (would drop animation), video, audio, documents, everything else.
  const ext = path.extname(absPath).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return;
  try {
    // Lazy require so a sharp load/binary problem can never crash module import
    // or the rest of the app — the catch below just skips the thumbnail.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharp = require('sharp');
    await sharp(absPath, { failOn: 'none' })
      .rotate() // honour EXIF orientation so portrait photos aren't sideways
      .resize({
        width: THUMB_MAX_EDGE,
        height: THUMB_MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 72 })
      .toFile(toThumbPath(absPath));
  } catch (err) {
    thumbLogger.warn(`Thumbnail generation failed for ${absPath}: ${err}`);
  }
}
