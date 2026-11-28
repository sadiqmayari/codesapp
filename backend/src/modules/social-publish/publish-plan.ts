/**
 * Pure rules for publishing a post to a Facebook Page / Instagram account.
 * No I/O — unit-tested in publish-plan.spec.ts. The worker turns a plan into
 * Graph calls; the composer shows the same validation messages.
 */

export type PostPlatform = 'facebook' | 'instagram';

export interface PostMedia {
  /** Absolute public URL Meta downloads the file from. */
  url: string;
  type: 'image' | 'video';
}

export const IG_CAPTION_MAX = 2200;
export const IG_HASHTAG_MAX = 30;
export const IG_CAROUSEL_MAX = 10;
export const FB_CAPTION_MAX = 63206;

export function countHashtags(caption: string): number {
  return (caption.match(/(^|\s)#[^\s#]+/g) ?? []).length;
}

/** Problems that stop this post from going to this platform (empty = ok). */
export function validatePost(platform: PostPlatform, caption: string, media: PostMedia[]): string[] {
  const errs: string[] = [];
  const videos = media.filter((m) => m.type === 'video').length;
  if (platform === 'instagram') {
    if (!media.length) errs.push('Instagram needs a photo or a video');
    if (caption.length > IG_CAPTION_MAX) errs.push(`Instagram captions are limited to ${IG_CAPTION_MAX} characters`);
    if (countHashtags(caption) > IG_HASHTAG_MAX) errs.push(`Instagram allows at most ${IG_HASHTAG_MAX} hashtags`);
    if (media.length > IG_CAROUSEL_MAX) errs.push(`Instagram carousels hold at most ${IG_CAROUSEL_MAX} items`);
  } else {
    if (!media.length && !caption.trim()) errs.push('Write something or add a photo or video');
    if (caption.length > FB_CAPTION_MAX) errs.push('The caption is too long for Facebook');
    if (videos && media.length > 1) errs.push('Facebook posts take either one video or photos, not both');
  }
  return errs;
}

/** One Graph step. `save` stores the returned id under a name for later steps. */
export interface GraphStep {
  method: 'POST' | 'GET';
  /** Path with `{page}` / `{ig}` / `{name}` placeholders resolved by the worker. */
  path: string;
  body?: Record<string, unknown>;
  save?: string;
  /** Instagram video containers: wait until status_code = FINISHED. */
  waitReady?: boolean;
}

/** The ordered Graph calls that publish this post to one target. */
export function buildPlan(platform: PostPlatform, caption: string, media: PostMedia[]): GraphStep[] {
  const steps: GraphStep[] = [];
  if (platform === 'facebook') {
    if (!media.length) {
      steps.push({ method: 'POST', path: '{page}/feed', body: { message: caption }, save: 'post' });
    } else if (media[0].type === 'video') {
      steps.push({ method: 'POST', path: '{page}/videos', body: { file_url: media[0].url, description: caption }, save: 'post' });
    } else if (media.length === 1) {
      steps.push({ method: 'POST', path: '{page}/photos', body: { url: media[0].url, message: caption }, save: 'post' });
    } else {
      media.forEach((m, i) => {
        steps.push({ method: 'POST', path: '{page}/photos', body: { url: m.url, published: false }, save: `photo${i}` });
      });
      steps.push({
        method: 'POST',
        path: '{page}/feed',
        body: { message: caption, attached_media: media.map((_, i) => ({ media_fbid: `{photo${i}}` })) },
        save: 'post',
      });
    }
    return steps;
  }
  // Instagram: create container(s) → (wait) → media_publish.
  if (media.length === 1) {
    const m = media[0];
    steps.push({
      method: 'POST',
      path: '{ig}/media',
      body: m.type === 'video' ? { media_type: 'REELS', video_url: m.url, caption } : { image_url: m.url, caption },
      save: 'container',
      waitReady: m.type === 'video',
    });
  } else {
    media.forEach((m, i) => {
      steps.push({
        method: 'POST',
        path: '{ig}/media',
        body: m.type === 'video'
          ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: true }
          : { image_url: m.url, is_carousel_item: true },
        save: `child${i}`,
        waitReady: m.type === 'video',
      });
    });
    steps.push({
      method: 'POST',
      path: '{ig}/media',
      body: { media_type: 'CAROUSEL', children: media.map((_, i) => `{child${i}}`).join(','), caption },
      save: 'container',
      waitReady: true,
    });
  }
  steps.push({ method: 'POST', path: '{ig}/media_publish', body: { creation_id: '{container}' }, save: 'post' });
  return steps;
}

/** Replace `{name}` placeholders (in strings, arrays and objects) with saved ids. */
export function fillPlaceholders<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === 'string') {
    return value.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m)) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, vars)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fillPlaceholders(v, vars)]),
    ) as T;
  }
  return value;
}

/** Overall post status from per-target results. */
export function overallStatus(results: Array<{ error?: string | null; externalId?: string | null }>): 'published' | 'partial' | 'failed' {
  const ok = results.filter((r) => r.externalId && !r.error).length;
  if (ok === results.length && ok > 0) return 'published';
  return ok > 0 ? 'partial' : 'failed';
}
