import { apiFetch } from '@/lib/api';

export interface SocialComment {
  id: number;
  platform: string;
  source: string;
  ad_id: string | null;
  ad_name: string | null;
  author_name: string | null;
  text: string;
  status: 'visible' | 'hidden';
  parent_external_id: string | null;
  commented_at: string;
  reply_text: string | null;
  replied_at: string | null;
}

export interface CommentList {
  rows: SocialComment[];
  total: number;
  page: number;
  limit: number;
  unreplied: number;
  hasAccounts: boolean;
}

export type CommentStatus = 'unreplied' | 'all' | 'visible' | 'hidden';

export const commentsApi = {
  list: (q: { status?: CommentStatus; q?: string; page?: number }, signal?: AbortSignal) => {
    const p = new URLSearchParams();
    if (q.status && q.status !== 'all') p.set('status', q.status);
    if (q.q) p.set('q', q.q);
    if (q.page) p.set('page', String(q.page));
    return apiFetch<CommentList>(`/social-comments?${p.toString()}`, { signal });
  },
  reply: (id: number, text: string) => apiFetch<SocialComment>(`/social-comments/${id}/reply`, { method: 'POST', body: { text } }),
  hide: (id: number) => apiFetch<SocialComment>(`/social-comments/${id}/hide`, { method: 'POST' }),
  unhide: (id: number) => apiFetch<SocialComment>(`/social-comments/${id}/unhide`, { method: 'POST' }),
  refresh: () => apiFetch<{ accounts: number; created: number; errors: string[] }>('/social-comments/refresh', { method: 'POST' }),
};
