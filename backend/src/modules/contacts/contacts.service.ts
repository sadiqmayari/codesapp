import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Contact, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { SegmentsService } from './segments.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { ListContactsDto } from './dto/list-contacts.dto';
import { ContactFilterDto } from './dto/contact-filter.dto';
import { BulkContactsDto, MergeContactsDto } from './dto/bulk-contacts.dto';
import {
  ContactFilter,
  contactOrderSql,
  contactWhereSql,
  normalizeTags,
  tagsOf,
} from './contact-query';
import {
  canonContactPhone,
  isValidContactPhone,
  phoneVariants,
} from '../../common/utils/contact-phone';

const DEFAULT_PAGE_SIZE = 50;
const BULK_MAX = 50_000;
const EXPORT_MAX = 200_000;
const MANAGER_ROLES = new Set(['owner', 'admin', 'super_admin']);

export interface ContactActor {
  companyId: number;
  userId?: number;
  role?: string;
}

const isManager = (a?: ContactActor) => !!a?.role && MANAGER_ROLES.has(a.role);

/** customFields: ≤50 keys, keys ≤64 chars, values stringified ≤1000 chars. */
function normalizeCustomFields(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const key = k.trim().slice(0, 64);
    if (!key || raw === undefined || raw === null) continue;
    out[key] = (typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 1000);
    if (Object.keys(out).length >= 50) break;
  }
  return out;
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralize spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metering: UsageMeteringService,
    private readonly segmentsService: SegmentsService,
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ---------------------------------------------------------------- events

  /**
   * Live `contact.updated` socket event (Inbox-v2 + Contacts 360): threads,
   * the conversation list and the contacts pages refresh a changed contact.
   * The gateway is resolved LAZILY — importing InboxModule here would close
   * the Billing↔Inbox↔UsageMetering import cycle. Best-effort. Public so other
   * writers (bots, couriers, Shopify) can reuse it.
   */
  emitContactUpdated(companyId: number, contactId: number | number[], change?: string) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { InboxGateway } = require('../inbox/inbox.gateway');
      const gw = this.moduleRef.get(InboxGateway, { strict: false }) as {
        emitToCompany?: (c: number, e: string, p: unknown) => void;
      } | null;
      const ids = Array.isArray(contactId) ? contactId : [contactId];
      if (ids.length > 50) {
        gw?.emitToCompany?.(companyId, 'contact.updated', { bulk: true, change });
      } else {
        for (const id of ids) gw?.emitToCompany?.(companyId, 'contact.updated', { contactId: id, change });
      }
    } catch {
      /* gateway not available (tests / CLI) */
    }
  }

  private async audit(
    actor: ContactActor | undefined,
    companyId: number,
    action: string,
    entityId: number | null,
    metadata?: Record<string, unknown>,
  ) {
    try {
      await this.prisma.auditLog.create({
        data: {
          company_id: companyId,
          user_id: actor?.userId ?? null,
          action,
          entity: 'contact',
          entity_id: entityId,
          metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (err) {
      this.logger.warn(`audit ${action} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ---------------------------------------------------------------- filter

  /** DTO (+ optional saved segment) → shared ContactFilter. Segment criteria AND the ad-hoc ones. */
  async buildFilter(companyId: number, dto: ContactFilterDto, actor?: ContactActor): Promise<ContactFilter> {
    if (dto.deleted && actor && !isManager(actor)) {
      throw new ForbiddenException('Only owners and admins can view deleted contacts');
    }
    const tags = [...(dto.tags ?? []), ...(dto.tag ? [dto.tag] : [])];
    const f: ContactFilter = {
      search: dto.search,
      status: dto.status,
      tags: tags.length ? tags : undefined,
      tagMode: dto.tagMode,
      excludeTags: dto.excludeTags,
      city: dto.city,
      hasEmail: dto.hasEmail,
      optedOut: dto.optedOut,
      lastMessageAfter: dto.lastMessageAfter,
      lastMessageBefore: dto.lastMessageBefore,
      createdAfter: dto.createdAfter,
      createdBefore: dto.createdBefore,
      deleted: dto.deleted,
    };
    if (dto.segmentId) {
      const seg = await this.segmentsService.get(companyId, dto.segmentId);
      const sf = SegmentsService.toContactFilter(seg.filter);
      // Merge: ad-hoc wins on scalar conflicts; tag lists are combined.
      return {
        ...sf,
        ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)),
        tags: [...(sf.tags ?? []), ...(f.tags ?? [])].length ? [...(sf.tags ?? []), ...(f.tags ?? [])] : undefined,
        excludeTags: [...(sf.excludeTags ?? []), ...(f.excludeTags ?? [])],
        tagMode: f.tags?.length ? f.tagMode : sf.tagMode,
      };
    }
    return f;
  }

  // ---------------------------------------------------------------- read

  async list(companyId: number, dto: ListContactsDto, actor?: ContactActor) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * limit;
    const f = await this.buildFilter(companyId, dto, actor);
    const where = contactWhereSql(companyId, f);
    const order = contactOrderSql(dto.sort, dto.dir);

    const [countRows, idRows] = await Promise.all([
      this.prisma.$queryRaw<{ c: bigint | number }[]>(
        Prisma.sql`SELECT COUNT(*) AS c FROM contacts WHERE ${where}`,
      ),
      this.prisma.$queryRaw<{ id: number }[]>(
        Prisma.sql`SELECT id FROM contacts WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
      ),
    ]);
    const ids = idRows.map((r) => Number(r.id));
    const rows = ids.length
      ? await this.prisma.contact.findMany({ where: { id: { in: ids }, company_id: companyId } })
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const data = ids.map((id) => byId.get(id)).filter((r): r is Contact => !!r);

    return {
      success: true,
      data,
      message: 'OK',
      meta: { page, limit, total: Number(countRows[0]?.c ?? 0) },
    };
  }

  async get(companyId: number, id: number) {
    const contact = await this.prisma.contact.findFirst({
      where: { id, company_id: companyId, deleted_at: null },
    });
    if (!contact) throw new NotFoundException('Contact not found');
    return contact;
  }

  /** Live contact by any stored variant of a phone (canonical or legacy '+'). */
  findByPhone(companyId: number, raw: string, includeDeleted = false) {
    return this.prisma.contact.findFirst({
      where: {
        company_id: companyId,
        phone: { in: phoneVariants(raw) },
        ...(includeDeleted ? {} : { deleted_at: null }),
      },
      orderBy: [{ deleted_at: 'asc' }, { last_message_at: 'desc' }, { id: 'asc' }],
    });
  }

  /**
   * Contact 360 — everything about one contact beyond its own row:
   * conversations, tickets, recent calls and team notes (across all of the
   * contact's chats). Orders come from the existing Shopify contact-orders
   * endpoint on the frontend (no commerce import here).
   */
  async overview(companyId: number, id: number) {
    const contact = await this.get(companyId, id);
    const [conversations, tickets, calls] = await Promise.all([
      this.prisma.conversation.findMany({
        where: { company_id: companyId, contact_id: id, deleted_at: null },
        orderBy: { id: 'desc' },
        take: 20,
        select: {
          id: true,
          status: true,
          last_message: true,
          last_message_at: true,
          unread_count: true,
          window_expires_at: true,
          created_at: true,
          assigned_user: { select: { id: true, name: true } },
        },
      }),
      this.prisma.supportTicket.findMany({
        where: { company_id: companyId, contact_id: id },
        orderBy: { id: 'desc' },
        take: 20,
        select: {
          id: true,
          ticket_number: true,
          type: true,
          status: true,
          priority: true,
          linked_order_name: true,
          created_at: true,
          closed_at: true,
        },
      }),
      this.prisma.callLog.findMany({
        where: { company_id: companyId, contact_id: id },
        orderBy: { id: 'desc' },
        take: 20,
        select: {
          id: true,
          direction: true,
          status: true,
          duration_sec: true,
          started_at: true,
          created_at: true,
          user: { select: { id: true, name: true } },
        },
      }),
    ]);
    const convIds = conversations.map((c) => c.id);
    const notesRaw = convIds.length
      ? await this.prisma.conversationNote.findMany({
          where: { company_id: companyId, conversation_id: { in: convIds } },
          orderBy: { id: 'desc' },
          take: 50,
        })
      : [];
    const authorIds = [...new Set(notesRaw.map((n) => n.user_id))];
    const authors = authorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: authorIds }, company_id: companyId },
          select: { id: true, name: true },
        })
      : [];
    const nameOf = new Map(authors.map((a) => [a.id, a.name]));
    const notes = notesRaw.map((n) => ({
      id: n.id,
      conversation_id: n.conversation_id,
      user_id: n.user_id,
      user_name: nameOf.get(n.user_id) ?? null,
      body: n.body,
      created_at: n.created_at,
    }));
    return { contact, conversations, tickets, calls, notes };
  }

  /**
   * Open chat from the CRM: the contact's latest live conversation, or a new
   * empty one (unassigned → visible in the agent pool) so the agent can send a
   * template. Mirrors CallsService.createConversation.
   */
  async ensureConversation(companyId: number, id: number) {
    await this.get(companyId, id);
    const existing = await this.prisma.conversation.findFirst({
      where: { company_id: companyId, contact_id: id, deleted_at: null },
      orderBy: [{ last_message_at: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (existing) return { conversationId: existing.id, created: false };
    const c = await this.prisma.conversation.create({
      data: { company_id: companyId, contact_id: id, status: 'open' },
      select: { id: true },
    });
    try {
      const { InboxGateway } = require('../inbox/inbox.gateway');
      const gw = this.moduleRef.get(InboxGateway, { strict: false }) as {
        emitToCompany?: (co: number, e: string, p: unknown) => void;
      } | null;
      gw?.emitToCompany?.(companyId, 'conversation.updated', { conversationId: c.id });
    } catch {
      /* best-effort */
    }
    return { conversationId: c.id, created: true };
  }

  /**
   * Distinct tags with usage counts (top 200), computed in SQL over EVERY
   * contact (the old version sampled an arbitrary 5,000 rows).
   */
  async distinctTags(companyId: number): Promise<string[]> {
    try {
      const rows = await this.prisma.$queryRaw<{ tag: string; c: bigint | number }[]>(Prisma.sql`
        SELECT jt.tag AS tag, COUNT(*) AS c
        FROM contacts c,
             JSON_TABLE(c.tags, '$[*]' COLUMNS (tag VARCHAR(100) CHARACTER SET utf8mb4 PATH '$')) jt
        WHERE c.company_id = ${companyId} AND c.deleted_at IS NULL AND jt.tag IS NOT NULL AND jt.tag <> ''
        GROUP BY jt.tag
        ORDER BY c DESC
        LIMIT 200`);
      return rows.map((r) => String(r.tag));
    } catch (err) {
      this.logger.warn(`distinctTags JSON_TABLE failed, falling back: ${err instanceof Error ? err.message : err}`);
      const rows = await this.prisma.contact.findMany({
        where: { company_id: companyId, deleted_at: null },
        select: { tags: true },
        take: 20000,
        orderBy: { id: 'desc' },
      });
      const counts = new Map<string, number>();
      for (const r of rows) for (const t of tagsOf(r.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
      return [...counts.entries()].sort(([, a], [, b]) => b - a).slice(0, 200).map(([t]) => t);
    }
  }

  // ---------------------------------------------------------------- write

  async create(companyId: number, dto: CreateContactDto, actor?: ContactActor) {
    const phone = canonContactPhone(dto.phone);
    if (!isValidContactPhone(phone)) {
      throw new BadRequestException('Enter a valid phone number with country code, e.g. 923001234567');
    }
    const existing = await this.findByPhone(companyId, phone, true);
    if (existing && !existing.deleted_at) {
      throw new ConflictException({
        message: 'A contact with this phone number already exists',
        contactId: existing.id,
      });
    }

    const fields = {
      name: dto.name.trim(),
      phone,
      email: dto.email ?? null,
      address: dto.address?.trim() || null,
      city: dto.city?.trim() || null,
      tags: normalizeTags(dto.tags ?? []),
      custom_fields: normalizeCustomFields(dto.customFields) as Prisma.InputJsonValue,
    };

    let contact: Contact;
    if (existing) {
      // Same number was soft-deleted: revive it (keeps its chat history) rather
      // than creating a second contact for the same person.
      contact = await this.prisma.contact.update({
        where: { id: existing.id },
        data: { ...fields, deleted_at: null, status: 'active' },
      });
      await this.audit(actor, companyId, 'contact.restored', contact.id, { via: 'create' });
    } else {
      contact = await this.prisma.contact.create({ data: { company_id: companyId, ...fields } });
      await this.metering.incrementContacts(companyId);
      await this.audit(actor, companyId, 'contact.created', contact.id);
    }
    await this.webhookDispatcher.dispatch(companyId, 'contact.created', {
      contactId: contact.id,
      phone: contact.phone,
      name: contact.name,
    });
    this.emitContactUpdated(companyId, contact.id, 'created');
    return contact;
  }

  async update(companyId: number, id: number, dto: UpdateContactDto, actor?: ContactActor) {
    const before = await this.get(companyId, id);
    const data: Prisma.ContactUpdateManyMutationInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.email !== undefined) data.email = dto.email || null;
    if (dto.address !== undefined) data.address = dto.address?.trim() || null;
    if (dto.city !== undefined) data.city = dto.city?.trim() || null;
    if (dto.tags !== undefined) data.tags = normalizeTags(dto.tags);
    if (dto.customFields !== undefined) {
      data.custom_fields = normalizeCustomFields(dto.customFields) as Prisma.InputJsonValue;
    }
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.optedOut !== undefined) {
      data.opted_out_at = dto.optedOut ? before.opted_out_at ?? new Date() : null;
      data.opt_out_source = dto.optedOut ? before.opt_out_source ?? 'agent' : null;
    }
    if (dto.phone !== undefined) {
      if (actor && !isManager(actor)) {
        throw new ForbiddenException('Only owners and admins can change a phone number');
      }
      const phone = canonContactPhone(dto.phone);
      if (!isValidContactPhone(phone)) throw new BadRequestException('Enter a valid phone number with country code');
      if (phone !== canonContactPhone(before.phone)) {
        const clash = await this.findByPhone(companyId, phone);
        if (clash && clash.id !== id) {
          throw new ConflictException({
            message: 'Another contact already uses this number — merge them instead',
            contactId: clash.id,
          });
        }
      }
      data.phone = phone;
    }

    // Scoped write: company_id in the WHERE, not just the pre-check.
    await this.prisma.contact.updateMany({ where: { id, company_id: companyId }, data });
    const updated = await this.get(companyId, id);

    if (dto.status !== undefined && dto.status !== before.status) {
      await this.audit(actor, companyId, `contact.status.${dto.status}`, id, { from: before.status });
    }
    if (dto.phone !== undefined && updated.phone !== before.phone) {
      await this.audit(actor, companyId, 'contact.phone_changed', id, { from: before.phone, to: updated.phone });
    }
    if (dto.optedOut !== undefined && !!before.opted_out_at !== dto.optedOut) {
      await this.audit(actor, companyId, dto.optedOut ? 'contact.opted_out' : 'contact.opted_in', id);
    }
    await this.webhookDispatcher.dispatch(companyId, 'contact.updated', {
      contactId: id,
      phone: updated.phone,
      name: updated.name,
    });
    this.emitContactUpdated(companyId, id, 'updated');
    return updated;
  }

  async softDelete(companyId: number, id: number, actor?: ContactActor) {
    await this.get(companyId, id);
    await this.prisma.contact.updateMany({
      where: { id, company_id: companyId },
      data: { deleted_at: new Date() },
    });
    await this.audit(actor, companyId, 'contact.deleted', id);
    this.emitContactUpdated(companyId, id, 'deleted');
    return { ok: true };
  }

  async restore(companyId: number, id: number, actor?: ContactActor) {
    const row = await this.prisma.contact.findFirst({
      where: { id, company_id: companyId, deleted_at: { not: null } },
    });
    if (!row) throw new NotFoundException('Deleted contact not found');
    const clash = await this.findByPhone(companyId, row.phone);
    if (clash) {
      throw new ConflictException({
        message: 'A live contact already uses this number — open it instead',
        contactId: clash.id,
      });
    }
    await this.prisma.contact.updateMany({ where: { id, company_id: companyId }, data: { deleted_at: null } });
    await this.audit(actor, companyId, 'contact.restored', id);
    this.emitContactUpdated(companyId, id, 'restored');
    return this.get(companyId, id);
  }

  // ---------------------------------------------------------------- bulk

  async bulk(companyId: number, dto: BulkContactsDto, actor?: ContactActor) {
    let ids: number[];
    if (dto.ids?.length) {
      const rows = await this.prisma.contact.findMany({
        where: {
          id: { in: dto.ids },
          company_id: companyId,
          deleted_at: dto.action === 'restore' ? { not: null } : null,
        },
        select: { id: true },
      });
      ids = rows.map((r) => r.id);
    } else if (dto.filter) {
      const f = await this.buildFilter(companyId, dto.filter, actor);
      if (dto.action === 'restore') f.deleted = true;
      ids = await this.segmentsService.resolveIds(companyId, f, BULK_MAX + 1);
      if (ids.length > BULK_MAX) {
        throw new BadRequestException(`Too many contacts (max ${BULK_MAX.toLocaleString()}) — narrow the filter`);
      }
    } else {
      throw new BadRequestException('Select contacts or provide a filter');
    }
    if (!ids.length) return { affected: 0 };

    let affected = 0;
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += 1000) chunks.push(ids.slice(i, i + 1000));

    switch (dto.action) {
      case 'tag_add':
      case 'tag_remove': {
        const tags = normalizeTags(dto.tags ?? []);
        if (!tags.length) throw new BadRequestException('Provide at least one tag');
        const lower = new Set(tags.map((t) => t.toLowerCase()));
        for (const chunk of chunks) {
          const rows = await this.prisma.contact.findMany({
            where: { id: { in: chunk }, company_id: companyId },
            select: { id: true, tags: true },
          });
          const writes = rows
            .map((r) => {
              const cur = tagsOf(r.tags);
              const next =
                dto.action === 'tag_add'
                  ? normalizeTags([...cur, ...tags])
                  : cur.filter((t) => !lower.has(t.toLowerCase()));
              return next.length === cur.length && next.every((t, i) => t === cur[i]) ? null : { id: r.id, next };
            })
            .filter((w): w is { id: number; next: string[] } => !!w);
          for (let i = 0; i < writes.length; i += 25) {
            await Promise.all(
              writes.slice(i, i + 25).map((w) =>
                this.prisma.contact.updateMany({
                  where: { id: w.id, company_id: companyId },
                  data: { tags: w.next },
                }),
              ),
            );
          }
          affected += writes.length;
        }
        break;
      }
      case 'status': {
        if (!dto.status) throw new BadRequestException('Provide a status');
        for (const chunk of chunks) {
          const r = await this.prisma.contact.updateMany({
            where: { id: { in: chunk }, company_id: companyId },
            data: { status: dto.status },
          });
          affected += r.count;
        }
        break;
      }
      case 'opt_out':
      case 'opt_in': {
        for (const chunk of chunks) {
          const r = await this.prisma.contact.updateMany({
            where: {
              id: { in: chunk },
              company_id: companyId,
              opted_out_at: dto.action === 'opt_out' ? null : { not: null },
            },
            data:
              dto.action === 'opt_out'
                ? { opted_out_at: new Date(), opt_out_source: 'agent' }
                : { opted_out_at: null, opt_out_source: null },
          });
          affected += r.count;
        }
        break;
      }
      case 'delete': {
        for (const chunk of chunks) {
          const r = await this.prisma.contact.updateMany({
            where: { id: { in: chunk }, company_id: companyId, deleted_at: null },
            data: { deleted_at: new Date() },
          });
          affected += r.count;
        }
        break;
      }
      case 'restore': {
        // Skip rows whose number now belongs to a live contact (would duplicate).
        for (const chunk of chunks) {
          const rows = await this.prisma.contact.findMany({
            where: { id: { in: chunk }, company_id: companyId, deleted_at: { not: null } },
            select: { id: true, phone: true },
          });
          const variants = rows.flatMap((r) => phoneVariants(r.phone));
          const live = variants.length
            ? await this.prisma.contact.findMany({
                where: { company_id: companyId, deleted_at: null, phone: { in: variants } },
                select: { phone: true },
              })
            : [];
          const taken = new Set(live.map((l) => canonContactPhone(l.phone)));
          const ok = rows.filter((r) => !taken.has(canonContactPhone(r.phone))).map((r) => r.id);
          if (!ok.length) continue;
          const r = await this.prisma.contact.updateMany({
            where: { id: { in: ok }, company_id: companyId },
            data: { deleted_at: null },
          });
          affected += r.count;
        }
        break;
      }
    }

    await this.audit(actor, companyId, `contact.bulk.${dto.action}`, null, {
      selected: ids.length,
      affected,
      tags: dto.tags,
      status: dto.status,
      byFilter: !dto.ids?.length,
    });
    this.emitContactUpdated(companyId, ids, `bulk.${dto.action}`);
    return { affected, selected: ids.length };
  }

  // ---------------------------------------------------------------- export

  async exportCsv(companyId: number, dto: ContactFilterDto & { sort?: string; dir?: string }, actor?: ContactActor) {
    const f = await this.buildFilter(companyId, dto, actor);
    const where = contactWhereSql(companyId, f);
    const order = contactOrderSql(dto.sort, dto.dir);
    const header = [
      'id', 'name', 'phone', 'email', 'city', 'address', 'tags', 'status',
      'opted_out_at', 'last_message_at', 'created_at', 'custom_fields',
    ];
    const lines: string[] = [header.join(',')];
    let offset = 0;
    for (;;) {
      const rows = await this.prisma.$queryRaw<
        Array<Record<string, unknown> & { tags: unknown; custom_fields: unknown }>
      >(Prisma.sql`
        SELECT id, name, phone, email, city, address, tags, status, opted_out_at,
               last_message_at, created_at, custom_fields
        FROM contacts WHERE ${where} ORDER BY ${order} LIMIT 2000 OFFSET ${offset}`);
      for (const r of rows) {
        const tags = typeof r.tags === 'string' ? tagsOf(JSON.parse(r.tags || '[]')) : tagsOf(r.tags);
        const cf = typeof r.custom_fields === 'string' ? r.custom_fields : JSON.stringify(r.custom_fields ?? {});
        const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d ?? '');
        lines.push(
          [
            r.id, r.name, r.phone, r.email, r.city, r.address, tags.join(', '), r.status,
            iso(r.opted_out_at), iso(r.last_message_at), iso(r.created_at), cf === '{}' ? '' : cf,
          ].map(csvCell).join(','),
        );
      }
      offset += rows.length;
      if (rows.length < 2000 || offset >= EXPORT_MAX) break;
    }
    await this.audit(actor, companyId, 'contact.exported', null, { rows: lines.length - 1 });
    // BOM so Excel opens UTF-8 (Urdu names, emoji tags) correctly.
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  // ---------------------------------------------------------------- duplicates

  /**
   * Groups of live contacts that are the same number stored in different forms
   * (bare digits vs '+E.164' — the pre-Contacts-360 duplicate source).
   */
  async duplicates(companyId: number) {
    const groups = await this.prisma.$queryRaw<{ canon: string; c: bigint | number; ids: string }[]>(Prisma.sql`
      SELECT REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', '') AS canon,
             COUNT(*) AS c, GROUP_CONCAT(id ORDER BY id) AS ids
      FROM contacts
      WHERE company_id = ${companyId} AND deleted_at IS NULL
      GROUP BY canon
      HAVING COUNT(*) > 1
      ORDER BY c DESC, canon
      LIMIT 200`);
    const allIds = groups.flatMap((g) => String(g.ids).split(',').map(Number));
    if (!allIds.length) return { total: 0, groups: [] };

    const [contacts, convCounts, ticketCounts, callCounts] = await Promise.all([
      this.prisma.contact.findMany({ where: { id: { in: allIds }, company_id: companyId } }),
      this.prisma.conversation.groupBy({
        by: ['contact_id'],
        where: { company_id: companyId, contact_id: { in: allIds }, deleted_at: null },
        _count: { _all: true },
      }),
      this.prisma.supportTicket.groupBy({
        by: ['contact_id'],
        where: { company_id: companyId, contact_id: { in: allIds } },
        _count: { _all: true },
      }),
      this.prisma.callLog.groupBy({
        by: ['contact_id'],
        where: { company_id: companyId, contact_id: { in: allIds } },
        _count: { _all: true },
      }),
    ]);
    const cnt = (rows: Array<{ contact_id: number | null; _count: { _all: number } }>) =>
      new Map(rows.map((r) => [r.contact_id as number, r._count._all]));
    const conv = cnt(convCounts);
    const tick = cnt(ticketCounts);
    const call = cnt(callCounts);
    const byId = new Map(contacts.map((c) => [c.id, c]));

    const out = groups.map((g) => {
      const members = String(g.ids)
        .split(',')
        .map(Number)
        .map((id) => byId.get(id))
        .filter((c): c is Contact => !!c)
        .map((c) => ({
          ...c,
          conversations: conv.get(c.id) ?? 0,
          tickets: tick.get(c.id) ?? 0,
          calls: call.get(c.id) ?? 0,
        }));
      // Suggested primary = most conversations, then most recent activity, then oldest.
      const suggested = [...members].sort(
        (a, b) =>
          b.conversations - a.conversations ||
          (b.last_message_at?.getTime() ?? 0) - (a.last_message_at?.getTime() ?? 0) ||
          a.id - b.id,
      )[0];
      return { phone: g.canon, suggestedPrimaryId: suggested?.id ?? members[0]?.id, contacts: members };
    });
    return { total: out.length, groups: out };
  }

  /**
   * Merge duplicates into `primaryId` in ONE transaction: re-point every
   * reference (conversations, tickets, calls, shipments, agent activity), union
   * tags + custom fields + missing profile fields onto the primary, then
   * soft-delete the merged rows. Irreversible re-pointing — owner/admin only.
   */
  async merge(companyId: number, dto: MergeContactsDto, actor?: ContactActor) {
    const mergeIds = [...new Set(dto.mergeIds)].filter((id) => id !== dto.primaryId);
    if (!mergeIds.length) throw new BadRequestException('Pick at least one other contact to merge');
    const all = await this.prisma.contact.findMany({
      where: { id: { in: [dto.primaryId, ...mergeIds] }, company_id: companyId, deleted_at: null },
    });
    const primary = all.find((c) => c.id === dto.primaryId);
    if (!primary) throw new NotFoundException('Primary contact not found');
    const losers = all.filter((c) => c.id !== dto.primaryId);
    if (losers.length !== mergeIds.length) throw new NotFoundException('Some contacts to merge were not found');

    const loserIds = losers.map((l) => l.id);
    const looksLikePhone = (n: string) => /^\+?\d[\d\s-]*$/.test(n.trim());
    const name =
      looksLikePhone(primary.name) ? losers.find((l) => !looksLikePhone(l.name))?.name ?? primary.name : primary.name;
    const customFields = Object.assign(
      {},
      ...losers.map((l) => (l.custom_fields && typeof l.custom_fields === 'object' ? l.custom_fields : {})),
      primary.custom_fields && typeof primary.custom_fields === 'object' ? primary.custom_fields : {},
    );
    const lastMsg = [primary, ...losers]
      .map((c) => c.last_message_at)
      .filter((d): d is Date => !!d)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const optedOut = [primary, ...losers].find((c) => c.opted_out_at);

    const moved = await this.prisma.$transaction(async (tx) => {
      const where = { company_id: companyId, contact_id: { in: loserIds } };
      const [conversations, tickets, calls, shipments, activity] = await Promise.all([
        tx.conversation.updateMany({ where, data: { contact_id: primary.id } }),
        tx.supportTicket.updateMany({ where, data: { contact_id: primary.id } }),
        tx.callLog.updateMany({ where, data: { contact_id: primary.id } }),
        tx.shipment.updateMany({ where, data: { contact_id: primary.id } }),
        tx.agentActivity.updateMany({ where, data: { contact_id: primary.id } }),
      ]);
      await tx.contact.updateMany({
        where: { id: primary.id, company_id: companyId },
        data: {
          name,
          phone: canonContactPhone(primary.phone) || primary.phone,
          email: primary.email || losers.find((l) => l.email)?.email || null,
          address: primary.address || losers.find((l) => l.address)?.address || null,
          city: primary.city || losers.find((l) => l.city)?.city || null,
          tags: normalizeTags([primary, ...losers].flatMap((c) => tagsOf(c.tags))),
          custom_fields: normalizeCustomFields(customFields) as Prisma.InputJsonValue,
          last_message_at: lastMsg,
          opted_out_at: optedOut?.opted_out_at ?? null,
          opt_out_source: optedOut?.opt_out_source ?? null,
        },
      });
      await tx.contact.updateMany({
        where: { id: { in: loserIds }, company_id: companyId },
        data: { deleted_at: new Date() },
      });
      return {
        conversations: conversations.count,
        tickets: tickets.count,
        calls: calls.count,
        shipments: shipments.count,
        activity: activity.count,
      };
    });

    await this.audit(actor, companyId, 'contact.merged', primary.id, { merged: loserIds, moved });
    this.emitContactUpdated(companyId, [primary.id, ...loserIds], 'merged');
    try {
      // Conversation lists re-fetch on this (chats now show the merged contact).
      const { InboxGateway } = require('../inbox/inbox.gateway');
      const gw = this.moduleRef.get(InboxGateway, { strict: false }) as {
        emitToCompany?: (c: number, e: string, p: unknown) => void;
      } | null;
      gw?.emitToCompany?.(companyId, 'conversation.updated', { contactId: primary.id });
    } catch {
      /* best-effort */
    }
    return { primaryId: primary.id, merged: loserIds, moved };
  }
}
