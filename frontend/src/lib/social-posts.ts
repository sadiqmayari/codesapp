import { apiFetch, postMultipart } from '@/lib/api';

export type PostPlatform = 'facebook' | 'instagram';

export interface PostAccount {
  metaPageId: number;
  platform: PostPlatform;
  name: string;
  pictureUrl: string | null;
}

export interface PostMediaItem {
  webPath: string;
  type: 'image' | 'video';
  mime?: string;
  /** Absolute URL (preview only). */
  url?: string;
}

export interface PostTarget {
  metaPageId: number;
  platform: PostPlatform;
}

export interface PostResult extends PostTarget {
  externalId: string | null;
  permalink: string | null;
  error: string | null;
  at: string;
}

export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled';

export interface SocialPost {
  id: number;
  contentItemId: number | null;
  caption: string;
  media: PostMediaItem[];
  targets: PostTarget[];
  status: PostStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  results: PostResult[];
  lastError: string | null;
  createdAt: string;
}

export interface PostList {
  rows: SocialPost[];
  total: number;
  page: number;
  counts: { scheduled: number; published: number; failed: number };
}

export interface PostInput {
  caption: string;
  media: PostMediaItem[];
  targets: PostTarget[];
  scheduledAt?: string | null;
}

export const IG_CAPTION_MAX = 2200;
export const IG_HASHTAG_MAX = 30;

export const countHashtags = (caption: string) => (caption.match(/(^|\s)#[^\s#]+/g) ?? []).length;

/** Mirrors backend publish-plan.validatePost (keep in sync). */
export function postProblems(targets: PostTarget[], caption: string, media: PostMediaItem[]): string[] {
  const out = new Set<string>();
  if (!targets.length) out.add('Pick at least one Page or Instagram account');
  const ig = targets.some((t) => t.platform === 'instagram');
  const fb = targets.some((t) => t.platform === 'facebook');
  if (ig) {
    if (!media.length) out.add('Instagram needs a photo or a video');
    if (caption.length > IG_CAPTION_MAX) out.add(`Instagram captions are limited to ${IG_CAPTION_MAX} characters`);
    if (countHashtags(caption) > IG_HASHTAG_MAX) out.add(`Instagram allows at most ${IG_HASHTAG_MAX} hashtags`);
    if (media.length > 10) out.add('Instagram carousels hold at most 10 items');
  }
  if (fb) {
    if (!media.length && !caption.trim()) out.add('Write something or add a photo or video');
    if (media.some((m) => m.type === 'video') && media.length > 1) out.add('Facebook posts take either one video or photos, not both');
  }
  return Array.from(out);
}

export const socialPostsApi = {
  accounts: () => apiFetch<{ accounts: PostAccount[] }>('/social-posts/accounts'),
  list: (tab: string, page = 1, signal?: AbortSignal) =>
    apiFetch<PostList>(`/social-posts?tab=${encodeURIComponent(tab)}&page=${page}`, { signal }),
  create: (body: PostInput) => apiFetch<SocialPost>('/social-posts', { method: 'POST', body }),
  update: (id: number, body: PostInput) => apiFetch<SocialPost>(`/social-posts/${id}`, { method: 'PATCH', body }),
  cancel: (id: number) => apiFetch<SocialPost>(`/social-posts/${id}/cancel`, { method: 'POST' }),
  retry: (id: number) => apiFetch<SocialPost>(`/social-posts/${id}/retry`, { method: 'POST' }),
  fromContent: (contentId: number, body: { caption?: string; targets: PostTarget[]; scheduledAt?: string | null }) =>
    apiFetch<SocialPost>(`/social-posts/from-content/${contentId}`, { method: 'POST', body }),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return postMultipart<PostMediaItem & { url: string }>('/social-posts/media', fd);
  },
};
