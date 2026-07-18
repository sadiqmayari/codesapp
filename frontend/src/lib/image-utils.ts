// Client-side image downscale before upload — WhatsApp-style. On HTTP/1.1 (our
// current transport) a media upload holds a connection AND saturates the uplink
// for its whole duration, so a multi-MB photo blocks every other request "until
// sent" (worst on agents with slow upload speed). Shrinking a 6–12MP / multi-MB
// phone photo to ~1600px / a few hundred KB makes the upload ~10–20× faster, so
// the block is barely perceptible. It also makes the optimistic preview decode
// far cheaper (helps Safari especially). Fully best-effort: any failure returns
// the ORIGINAL file unchanged, so a send never breaks because of this.

const MAX_EDGE = 1600; // longest side, px — WhatsApp-grade for a chat photo
const QUALITY = 0.82; // JPEG quality
// Leave already-small images alone (don't re-encode and lose quality for
// nothing): only process when the photo is genuinely large.
const SKIP_UNDER_BYTES = 900 * 1024; // ~0.9 MB

/**
 * Downscale/compress an image File for sending. Returns a smaller JPEG File when
 * worthwhile, otherwise the original File untouched. Non-image inputs and any
 * error path return the input as-is.
 */
export async function downscaleImageForSend(file: File): Promise<File> {
  try {
    if (
      typeof window === 'undefined' ||
      !file.type.startsWith('image/') ||
      file.type === 'image/gif' // keep animation
    ) {
      return file;
    }
    if (
      typeof createImageBitmap !== 'function' ||
      typeof OffscreenCanvas === 'undefined'
    ) {
      // Older browser without the off-thread path — skip rather than risk a
      // slow main-thread canvas decode.
      return file;
    }

    // Decode + (optionally) resize OFF the main thread. `imageOrientation` bakes
    // in EXIF rotation so portrait phone photos aren't sent sideways.
    const probe = await createImageBitmap(file, {
      imageOrientation: 'from-image',
    });
    const { width, height } = probe;
    const longest = Math.max(width, height);

    // Small already (both under the cap AND light) → leave untouched.
    if (longest <= MAX_EDGE && file.size < SKIP_UNDER_BYTES) {
      probe.close();
      return file;
    }

    const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      probe.close();
      return file;
    }
    ctx.drawImage(probe, 0, 0, w, h);
    probe.close();

    const blob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: QUALITY,
    });
    // Guard against a pathological case where the "compressed" output is not
    // actually smaller (e.g. a tiny source): keep whichever is smaller.
    if (blob.size >= file.size) return file;

    const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
