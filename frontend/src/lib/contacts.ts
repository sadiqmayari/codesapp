import { api, apiFetch, apiFetchEnvelope, postMultipart } from './api';
import type { Contact, ContactStatus } from './crm-types';

/**
 * Contacts 360 — typed API + filter helpers. The filter shape mirrors the
 * backend `ContactFilterDto` so list, export and bulk-by-filter select the
 * exact same rows.
 */
export interface ContactListFilter {
  search?: string;
  status?: ContactStatus;
  tags?: string[];
  tagMode?: 'all' | 'any';
  city?: string;
  hasEmail?: boolean;
  optedOut?: boolean;
  lastMessageAfter?: string;
  lastMessageBefore?: string;
  segmentId?: number;
  deleted?: boolean;
}

export type ContactSortKey = 'last_message_at' | 'name' | 'created_at' | 'id';
export interface ContactListQuery extends ContactListFilter {
  page?: number;
  limit?: number;
  sort?: ContactSortKey;
  dir?: 'asc' | 'desc';
}

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Filter → query params (arrays as comma lists, empties dropped). */
export function filterParams(q: ContactListQuery): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {};
  for (const [k, v] of Object.entries(q)) {
    if (isEmpty(v)) continue;
    if (Array.isArray(v)) out[k] = v.join(',');
    else if (typeof v === 'boolean') out[k] = String(v);
    else out[k] = v as string | number;
  }
  return out;
}

/** URL search params → list query (filters survive back-navigation + sharing). */
export function queryFromSearch(sp: URLSearchParams): ContactListQuery {
  const bool = (k: string) => (sp.get(k) === 'true' ? true : sp.get(k) === 'false' ? false : undefined);
  const num = (k: string) => {
    const n = Number(sp.get(k));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const status = sp.get('status');
  const sort = sp.get('sort');
  return {
    search: sp.get('q') ?? undefined,
    status: status === 'active' || status === 'blocked' || status === 'archived' ? status : undefined,
    tags: sp.get('tags')?.split(',').filter(Boolean),
    tagMode: sp.get('tagMode') === 'any' ? 'any' : undefined,
    city: sp.get('city') ?? undefined,
    hasEmail: bool('hasEmail'),
    optedOut: bool('optedOut'),
    lastMessageAfter: sp.get('after') ?? undefined,
    lastMessageBefore: sp.get('before') ?? undefined,
    segmentId: num('segment'),
    deleted: sp.get('deleted') === 'true' || undefined,
    page: num('page'),
    limit: num('limit'),
    sort:
      sort === 'name' || sort === 'created_at' || sort === 'id' || sort === 'last_message_at'
        ? sort
        : undefined,
    dir: sp.get('dir') === 'asc' ? 'asc' : sp.get('dir') === 'desc' ? 'desc' : undefined,
  };
}

/** List query → URL search string (defaults omitted to keep URLs short). */
export function searchFromQuery(q: ContactListQuery): string {
  const sp = new URLSearchParams();
  const set = (k: string, v: unknown) => {
    if (isEmpty(v)) return;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  };
  set('q', q.search);
  set('status', q.status);
  set('tags', q.tags);
  set('tagMode', q.tagMode === 'any' ? 'any' : undefined);
  set('city', q.city);
  set('hasEmail', q.hasEmail);
  set('optedOut', q.optedOut);
  set('after', q.lastMessageAfter);
  set('before', q.lastMessageBefore);
  set('segment', q.segmentId);
  set('deleted', q.deleted ? 'true' : undefined);
  set('page', q.page && q.page > 1 ? q.page : undefined);
  set('limit', q.limit && q.limit !== 25 ? q.limit : undefined);
  set('sort', q.sort && q.sort !== 'last_message_at' ? q.sort : undefined);
  set('dir', q.dir === 'asc' ? 'asc' : undefined);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Filter-only part (no paging/sort) — what "select all matching" acts on. */
export function filterOnly(q: ContactListQuery): ContactListFilter {
  const f: ContactListFilter = { ...q };
  delete (f as ContactListQuery).page;
  delete (f as ContactListQuery).limit;
  delete (f as ContactListQuery).sort;
  delete (f as ContactListQuery).dir;
  return f;
}

export function hasActiveFilters(q: ContactListQuery): boolean {
  const f = filterOnly(q);
  return Object.values(f).some((v) => !isEmpty(v));
}

export function listContacts(q: ContactListQuery) {
  return apiFetchEnvelope<Contact[]>('/contacts', { params: filterParams(q) });
}

export function getContact(id: number) {
  return apiFetch<Contact>(`/contacts/${id}`);
}

export function updateContact(id: number, body: Record<string, unknown>) {
  return apiFetch<Contact>(`/contacts/${id}`, { method: 'PATCH', body });
}

export function deleteContact(id: number) {
  return apiFetch<{ ok: true }>(`/contacts/${id}`, { method: 'DELETE' });
}

export function restoreContact(id: number) {
  return apiFetch<Contact>(`/contacts/${id}/restore`, { method: 'POST' });
}

export function listContactTags() {
  return apiFetch<string[]>('/contacts/tags');
}

/** The contact's latest chat, created empty if none (Open chat / Send template). */
export function ensureConversation(id: number) {
  return apiFetch<{ conversationId: number; created: boolean }>(`/contacts/${id}/conversation`, {
    method: 'POST',
  });
}

export type BulkAction =
  | 'tag_add'
  | 'tag_remove'
  | 'status'
  | 'opt_out'
  | 'opt_in'
  | 'delete'
  | 'restore';

export function bulkContacts(body: {
  action: BulkAction;
  ids?: number[];
  filter?: ContactListFilter;
  tags?: string[];
  status?: ContactStatus;
}) {
  const filter = body.filter
    ? Object.fromEntries(Object.entries(body.filter).filter(([, v]) => !isEmpty(v)))
    : undefined;
  return apiFetch<{ affected: number; selected: number }>('/contacts/bulk', {
    method: 'POST',
    body: { ...body, filter },
  });
}

/** Download the CSV export for a filter (blob → temporary <a download>). */
export async function downloadContactsCsv(q: ContactListQuery) {
  const res = await api.get('/contacts/export', {
    params: filterParams({ ...filterOnly(q), sort: q.sort, dir: q.dir }),
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- 360

export interface ContactOverview {
  contact: Contact;
  conversations: Array<{
    id: number;
    status: string;
    last_message: string | null;
    last_message_at: string | null;
    unread_count: number;
    window_expires_at: string | null;
    created_at: string;
    assigned_user: { id: number; name: string } | null;
  }>;
  tickets: Array<{
    id: number;
    ticket_number: string;
    type: string;
    status: string;
    priority: string | null;
    linked_order_name: string | null;
    created_at: string;
    closed_at: string | null;
  }>;
  calls: Array<{
    id: number;
    direction: 'inbound' | 'outbound';
    status: string;
    duration_sec: number | null;
    started_at: string | null;
    created_at: string;
    user: { id: number; name: string } | null;
  }>;
  notes: Array<{
    id: number;
    conversation_id: number;
    user_id: number;
    user_name: string | null;
    body: string;
    created_at: string;
  }>;
}

export function getContactOverview(id: number) {
  return apiFetch<ContactOverview>(`/contacts/${id}/overview`);
}

// ---------------------------------------------------------------- duplicates

export interface DuplicateContact extends Contact {
  conversations: number;
  tickets: number;
  calls: number;
}
export interface DuplicateGroup {
  phone: string;
  suggestedPrimaryId: number;
  contacts: DuplicateContact[];
}

export function listDuplicates() {
  return apiFetch<{ total: number; groups: DuplicateGroup[] }>('/contacts/duplicates');
}

export function mergeContacts(primaryId: number, mergeIds: number[]) {
  return apiFetch<{
    primaryId: number;
    merged: number[];
    moved: { conversations: number; tickets: number; calls: number; shipments: number; activity: number };
  }>('/contacts/merge', { method: 'POST', body: { primaryId, mergeIds } });
}

// ---------------------------------------------------------------- import

export interface CsvRowError {
  row: number;
  reason: string;
}
export interface CsvImportSummary {
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
  capped: boolean;
  total: number;
  errors: CsvRowError[];
}
export interface CsvImportJob {
  jobId: string;
  status: 'running' | 'done' | 'failed';
  processed: number;
  total: number;
  summary?: CsvImportSummary;
  error?: string;
}

export function importContactsCsv(file: File, mode: 'skip' | 'update') {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('mode', mode);
  return postMultipart<CsvImportSummary | CsvImportJob>('/contacts/import', fd);
}

export function getImportJob(jobId: string) {
  return apiFetch<CsvImportJob>(`/contacts/import/${encodeURIComponent(jobId)}`);
}

// ---------------------------------------------------------------- display

/** Canonical digits → "+92 300 1234567" (PK grouping; others "+<digits>"). */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (d.startsWith('92') && d.length === 12) return `+92 ${d.slice(2, 5)} ${d.slice(5)}`;
  return d ? `+${d}` : raw;
}

export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    // Words that contain a letter (Latin or any non-ASCII script), not "+92…".
    .filter((p) => /[A-Za-zÀ-￿]/.test(p));
  if (!parts.length) return '#';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase();
}

export const isManagerRole = (role?: string | null) =>
  role === 'owner' || role === 'admin' || role === 'super_admin';

/** Loose client-side phone check (server canonicalizes): 7–15 digits after cleanup. */
export function looksLikePhone(raw: string): boolean {
  const d = raw.replace(/\D/g, '');
  return d.length >= 10 && d.length <= 15;
}
