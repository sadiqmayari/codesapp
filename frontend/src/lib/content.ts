import { apiFetch, postMultipart } from '@/lib/api';

export type ContentStatus =
  | 'planned'
  | 'uploaded'
  | 'in_review'
  | 'approved'
  | 'needs_changes'
  | 'rejected'
  | 'published';

export interface ContentItem {
  id: number;
  company_id: number;
  created_by_user_id: number | null;
  title: string;
  caption: string | null;
  media_type: 'image' | 'video' | null;
  platform: string | null;
  drive_file_id: string | null;
  mime: string | null;
  size_bytes: number | null;
  status: ContentStatus;
  review_feedback: string | null;
  reviewed_by_user_id: number | null;
  reviewed_at: string | null;
  assignee_user_id: number | null;
  reference_drive_file_id: string | null;
  reference_media_type: 'image' | 'video' | null;
  scheduled_publish_at: string | null;
  deadline: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Assignee {
  id: number;
  name: string;
  role: string;
}

export interface ContentEvent {
  id: number;
  content_item_id: number;
  actor_user_id: number | null;
  actor_name: string | null;
  type: string;
  detail: string | null;
  created_at: string;
}

export interface DriveStatus {
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
}

export interface ContentStats {
  total: number;
  byStatus: Record<string, number>;
  overdue: number;
}

export interface PlanInput {
  title: string;
  caption?: string;
  platform?: string;
  scheduledPublishAt?: string;
  deadline?: string;
  assigneeUserId?: number;
}

// ── Drive playback / thumbnail URLs (served by Google, NOT our VPS) ──────────
export function driveThumbUrl(fileId: string, w = 640): string {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${w}`;
}
export function drivePreviewUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/preview`;
}

// ── API calls ────────────────────────────────────────────────────────────────
export function listContent(status?: string): Promise<ContentItem[]> {
  const q = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : '';
  return apiFetch<ContentItem[]>(`/content${q}`);
}

export function getContent(id: number): Promise<ContentItem> {
  return apiFetch<ContentItem>(`/content/${id}`);
}

export function getContentStats(): Promise<ContentStats> {
  return apiFetch<ContentStats>('/content/stats');
}

export function getContentCalendar(
  from: string,
  to: string,
): Promise<ContentItem[]> {
  return apiFetch<ContentItem[]>(
    `/content/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
}

export function uploadContent(
  file: File,
  meta: PlanInput,
): Promise<ContentItem> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('title', meta.title);
  if (meta.caption) fd.append('caption', meta.caption);
  if (meta.platform) fd.append('platform', meta.platform);
  if (meta.scheduledPublishAt)
    fd.append('scheduledPublishAt', meta.scheduledPublishAt);
  if (meta.deadline) fd.append('deadline', meta.deadline);
  if (meta.assigneeUserId != null)
    fd.append('assigneeUserId', String(meta.assigneeUserId));
  return postMultipart<ContentItem>('/content/upload', fd);
}

export function listAssignees(): Promise<Assignee[]> {
  return apiFetch<Assignee[]>('/content/assignees');
}

export function assignContent(
  id: number,
  assigneeUserId: number | null,
): Promise<ContentItem> {
  return apiFetch<ContentItem>(`/content/${id}/assign`, {
    method: 'PATCH',
    body: { assigneeUserId },
  });
}

export function getContentEvents(id: number): Promise<ContentEvent[]> {
  return apiFetch<ContentEvent[]>(`/content/${id}/events`);
}

/** Attach/replace the optional reference image/video (the brief visual). */
export function attachReference(id: number, file: File): Promise<ContentItem> {
  const fd = new FormData();
  fd.append('file', file);
  return postMultipart<ContentItem>(`/content/${id}/reference`, fd);
}

export function removeReference(id: number): Promise<ContentItem> {
  return apiFetch<ContentItem>(`/content/${id}/reference`, { method: 'DELETE' });
}

/** Create a planned item with no media (plan-then-produce). */
export function planContent(meta: PlanInput): Promise<ContentItem> {
  return apiFetch<ContentItem>('/content/plan', { method: 'POST', body: meta });
}

/** Plan several items at once. */
export function planContentBulk(
  items: PlanInput[],
): Promise<{ ok: boolean; count: number }> {
  return apiFetch('/content/plan/bulk', { method: 'POST', body: { items } });
}

/** Attach the real media file to a planned item. */
export function attachContentMedia(id: number, file: File): Promise<ContentItem> {
  const fd = new FormData();
  fd.append('file', file);
  return postMultipart<ContentItem>(`/content/${id}/media`, fd);
}

export function reviewContent(
  id: number,
  decision: 'approved' | 'needs_changes' | 'rejected',
  feedback?: string,
): Promise<ContentItem> {
  return apiFetch<ContentItem>(`/content/${id}/review`, {
    method: 'PATCH',
    body: { decision, feedback },
  });
}

export function scheduleContent(
  id: number,
  patch: { scheduledPublishAt?: string | null; deadline?: string | null },
): Promise<ContentItem> {
  return apiFetch<ContentItem>(`/content/${id}/schedule`, {
    method: 'PATCH',
    body: patch,
  });
}

export function publishContent(id: number): Promise<ContentItem> {
  return apiFetch<ContentItem>(`/content/${id}/publish`, { method: 'PATCH' });
}

export function deleteContent(id: number): Promise<unknown> {
  return apiFetch(`/content/${id}`, { method: 'DELETE' });
}

export function getDriveStatus(): Promise<DriveStatus> {
  return apiFetch<DriveStatus>('/content/drive/status');
}

export function getDriveConnectUrl(): Promise<{ url: string }> {
  return apiFetch<{ url: string }>('/content/drive/connect');
}

export function disconnectDrive(): Promise<unknown> {
  return apiFetch('/content/drive/disconnect', { method: 'POST' });
}

// ── UI helpers ────────────────────────────────────────────────────────────────
export const STATUS_META: Record<
  ContentStatus,
  { label: string; cls: string }
> = {
  planned: { label: 'Planned', cls: 'bg-gray-100 text-gray-700' },
  uploaded: { label: 'Uploaded', cls: 'bg-blue-100 text-blue-700' },
  in_review: { label: 'In review', cls: 'bg-amber-100 text-amber-700' },
  approved: { label: 'Approved', cls: 'bg-green-100 text-green-700' },
  needs_changes: { label: 'Needs changes', cls: 'bg-orange-100 text-orange-700' },
  rejected: { label: 'Rejected', cls: 'bg-red-100 text-red-700' },
  published: { label: 'Published', cls: 'bg-violet-100 text-violet-700' },
};
