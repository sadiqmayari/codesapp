import { Prisma } from '@prisma/client';
import { phoneSearchDigits } from '../../common/utils/contact-phone';
import { likeContains } from '../../common/utils/search';

/**
 * Contacts 360 — THE single contact filter.
 *
 * Every surface that selects contacts by criteria (list, export, bulk-by-filter,
 * segment count/preview/resolve, broadcast audiences) builds its WHERE clause
 * here, in SQL. Tags used to be filtered in JS AFTER pagination, which made
 * pages short/empty and `meta.total` wrong, and segment resolution was capped
 * at 10,000 rows (broadcasts silently truncated). Don't reintroduce JS-side
 * filtering.
 *
 * Tag match = case-insensitive JSON-string match on the serialized array
 * (`LOWER(CAST(tags AS CHAR)) LIKE '%"vip"%'`) — portable across MySQL 8 and
 * MariaDB 11 (prod), and immune to JSON whitespace differences.
 */
export interface ContactFilter {
  search?: string;
  status?: 'active' | 'blocked' | 'archived';
  tags?: string[];
  tagMode?: 'all' | 'any';
  excludeTags?: string[];
  city?: string;
  hasEmail?: boolean;
  optedOut?: boolean;
  lastMessageAfter?: string;
  lastMessageBefore?: string;
  createdAfter?: string;
  createdBefore?: string;
  ids?: number[];
  /** Broadcast use: never include blocked or opted-out contacts. */
  sendableOnly?: boolean;
  /** Show soft-deleted contacts instead of live ones (restore view). */
  deleted?: boolean;
}

const like = likeContains;

function tagCond(tag: string): Prisma.Sql {
  const t = tag.trim().toLowerCase();
  // JSON serializes a string as "…" with `"` and `\` escaped.
  const json = JSON.stringify(t);
  return Prisma.sql`LOWER(CAST(tags AS CHAR)) LIKE ${like(json)}`;
}

/** Date bound: a bare `YYYY-MM-DD` "before" covers that WHOLE day. */
function dateBound(v: string, end: boolean): { op: 'gte' | 'lt'; at: Date } | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return null;
    if (end) d.setUTCDate(d.getUTCDate() + 1);
    return { op: end ? 'lt' : 'gte', at: d };
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return { op: end ? 'lt' : 'gte', at: end ? new Date(d.getTime() + 1) : d };
}

function range(col: string, after?: string, before?: string): Prisma.Sql[] {
  const out: Prisma.Sql[] = [];
  const c = Prisma.raw(col);
  const a = after ? dateBound(after, false) : null;
  const b = before ? dateBound(before, true) : null;
  if (a) out.push(Prisma.sql`${c} >= ${a.at}`);
  if (b) out.push(Prisma.sql`${c} < ${b.at}`);
  return out;
}

/** WHERE fragment (no leading `WHERE`) — always tenant-scoped. */
export function contactWhereSql(companyId: number, f: ContactFilter = {}): Prisma.Sql {
  const conds: Prisma.Sql[] = [Prisma.sql`company_id = ${companyId}`];
  conds.push(f.deleted ? Prisma.sql`deleted_at IS NOT NULL` : Prisma.sql`deleted_at IS NULL`);

  if (f.status) conds.push(Prisma.sql`status = ${f.status}`);
  if (f.sendableOnly) {
    conds.push(Prisma.sql`status <> 'blocked'`);
    conds.push(Prisma.sql`opted_out_at IS NULL`);
  }

  const q = f.search?.trim();
  if (q) {
    const ors: Prisma.Sql[] = [
      Prisma.sql`name LIKE ${like(q)}`,
      Prisma.sql`email LIKE ${like(q)}`,
    ];
    const digits = phoneSearchDigits(q);
    if (digits) ors.push(Prisma.sql`phone LIKE ${like(digits)}`);
    conds.push(Prisma.sql`(${Prisma.join(ors, ' OR ')})`);
  }

  const tags = (f.tags ?? []).map((t) => t.trim()).filter(Boolean);
  if (tags.length) {
    const parts = tags.map(tagCond);
    conds.push(
      Prisma.sql`(${Prisma.join(parts, f.tagMode === 'any' ? ' OR ' : ' AND ')})`,
    );
  }
  for (const t of (f.excludeTags ?? []).map((x) => x.trim()).filter(Boolean)) {
    conds.push(Prisma.sql`NOT (${tagCond(t)})`);
  }

  if (f.city?.trim()) conds.push(Prisma.sql`city LIKE ${like(f.city.trim())}`);
  if (f.hasEmail === true) conds.push(Prisma.sql`(email IS NOT NULL AND email <> '')`);
  if (f.hasEmail === false) conds.push(Prisma.sql`(email IS NULL OR email = '')`);
  if (f.optedOut === true) conds.push(Prisma.sql`opted_out_at IS NOT NULL`);
  if (f.optedOut === false) conds.push(Prisma.sql`opted_out_at IS NULL`);

  conds.push(...range('last_message_at', f.lastMessageAfter, f.lastMessageBefore));
  conds.push(...range('created_at', f.createdAfter, f.createdBefore));

  if (f.ids) {
    const ids = f.ids.filter((n) => Number.isInteger(n));
    conds.push(ids.length ? Prisma.sql`id IN (${Prisma.join(ids)})` : Prisma.sql`1 = 0`);
  }

  return Prisma.join(conds, ' AND ');
}

export type ContactSort = 'name' | 'last_message_at' | 'created_at' | 'id';

/** Whitelisted ORDER BY — never interpolate the raw param. NULLs last. */
export function contactOrderSql(sort?: string, dir?: string): Prisma.Sql {
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  switch (sort) {
    case 'name':
      return Prisma.raw(`name ${d}, id DESC`);
    case 'last_message_at':
      return Prisma.raw(`last_message_at IS NULL, last_message_at ${d}, id DESC`);
    case 'created_at':
      return Prisma.raw(`created_at ${d}, id ${d}`);
    default:
      return Prisma.raw(`id ${d}`);
  }
}

/** Trim, drop empties, cap length/count, case-insensitive de-dupe (first spelling wins). */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().slice(0, 50);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 50) break;
  }
  return out;
}

/** Contacts' `tags` JSON → string[] (tolerates null/garbage). */
export function tagsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
