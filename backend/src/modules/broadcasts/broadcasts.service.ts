import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { MetaClientService } from '../inbox/meta-client.service';
import { SegmentsService } from '../contacts/segments.service';
import { SegmentFilterDto } from '../contacts/dto/create-segment.dto';
import { CreateBroadcastDto } from './dto/create-broadcast.dto';
import { ScheduleBroadcastDto } from './dto/schedule-broadcast.dto';
import { ListBroadcastsDto } from './dto/list-broadcasts.dto';
import { PreviewAudienceDto } from './dto/preview-audience.dto';
import { TestSendDto } from './dto/test-send.dto';

const PROGRESS_EMIT_EVERY = 25;
const THROTTLE_SPACING_MS = 100; // 10 msg/sec

/** Minimal contact shape needed to resolve per-recipient personalization. */
export interface PersonalizationContact {
  name: string | null;
  phone: string | null;
  email: string | null;
  custom_fields: unknown;
}

@Injectable()
export class BroadcastsService {
  private readonly logger = new Logger(BroadcastsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly segmentsService: SegmentsService,
    private readonly metaClient: MetaClientService,
  ) {}

  list(companyId: number, dto: ListBroadcastsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = (page - 1) * limit;
    const where: Prisma.BroadcastWhereInput = { company_id: companyId };
    if (dto.status) where.status = dto.status;
    return this.prisma.broadcast.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip,
      take: limit,
    });
  }

  async get(companyId: number, id: number) {
    const b = await this.prisma.broadcast.findFirst({
      where: { id, company_id: companyId },
    });
    if (!b) throw new NotFoundException('Broadcast not found');
    return b;
  }

  async create(companyId: number, dto: CreateBroadcastDto) {
    // validate template
    const tpl = await this.prisma.template.findFirst({
      where: { id: dto.templateId, company_id: companyId, deleted_at: null },
    });
    if (!tpl) throw new NotFoundException('Template not found');

    const audience: Record<string, unknown> = {};
    if (dto.all) audience.all = true;
    if (dto.contactIds?.length) audience.contactIds = dto.contactIds;
    if (dto.filter) audience.filter = dto.filter;
    if (dto.segmentId) audience.segmentId = dto.segmentId;
    if (dto.variables) audience.variables = dto.variables;

    return this.prisma.broadcast.create({
      data: {
        company_id: companyId,
        template_id: dto.templateId,
        name: dto.name,
        audience_filter: audience as unknown as object,
        status: 'draft',
      },
    });
  }

  async update(companyId: number, id: number, dto: CreateBroadcastDto) {
    const b = await this.get(companyId, id);
    if (b.status !== 'draft') {
      throw new BadRequestException('Only draft broadcasts can be edited');
    }
    const audience: Record<string, unknown> = {};
    if (dto.all) audience.all = true;
    if (dto.contactIds?.length) audience.contactIds = dto.contactIds;
    if (dto.filter) audience.filter = dto.filter;
    if (dto.segmentId) audience.segmentId = dto.segmentId;
    if (dto.variables) audience.variables = dto.variables;

    return this.prisma.broadcast.update({
      where: { id },
      data: {
        name: dto.name,
        template_id: dto.templateId,
        audience_filter: audience as unknown as object,
      },
    });
  }

  async sendNow(companyId: number, id: number) {
    const b = await this.get(companyId, id);
    if (b.status !== 'draft' && b.status !== 'scheduled') {
      throw new BadRequestException(`Cannot send broadcast in status ${b.status}`);
    }
    await this.dispatch(companyId, id);
    return { ok: true };
  }

  async schedule(companyId: number, id: number, dto: ScheduleBroadcastDto) {
    const b = await this.get(companyId, id);
    if (b.status !== 'draft') {
      throw new BadRequestException('Only draft broadcasts can be scheduled');
    }
    const runAt = new Date(dto.runAt);
    if (runAt.getTime() <= Date.now()) {
      throw new BadRequestException('runAt must be in the future');
    }
    await this.prisma.broadcast.update({
      where: { id },
      data: { status: 'scheduled', scheduled_at: runAt },
    });
    // schedule a single "dispatch" job — when it fires, we'll fan out
    await this.jobQueue.enqueue(
      'broadcast',
      { kind: 'dispatch', broadcastId: id, companyId },
      { delayMs: runAt.getTime() - Date.now() },
    );
    return { ok: true, runAt };
  }

  async cancel(companyId: number, id: number) {
    const b = await this.get(companyId, id);
    if (!['draft', 'scheduled', 'sending'].includes(b.status)) {
      throw new BadRequestException(`Cannot cancel broadcast in status ${b.status}`);
    }
    // Delete pending jobs for this broadcast
    await this.prisma.$executeRaw`
      DELETE FROM jobs
      WHERE queue_name = 'broadcast'
        AND status = 'pending'
        AND JSON_EXTRACT(payload, '$.broadcastId') = ${id}
    `;
    await this.prisma.broadcast.update({
      where: { id },
      data: { status: 'cancelled' },
    });
    return { ok: true };
  }

  async analytics(companyId: number, id: number) {
    const b = await this.get(companyId, id);
    const audience = b.audience_filter as Record<string, unknown>;
    const totalSeed = await this.resolveAudienceSize(companyId, audience);
    return {
      id: b.id,
      name: b.name,
      status: b.status,
      total: totalSeed,
      sent: b.sent_count,
      delivered: b.delivered_count,
      read: b.read_count,
      failed: b.failed_count,
      scheduledAt: b.scheduled_at,
      createdAt: b.created_at,
    };
  }

  /**
   * Live audience resolution for the campaign builder — count + a small
   * sample, without persisting anything.
   */
  async previewAudience(companyId: number, dto: PreviewAudienceDto) {
    const audience: Record<string, unknown> = {};
    if (dto.all) audience.all = true;
    if (dto.contactIds?.length) audience.contactIds = dto.contactIds;
    if (dto.filter) audience.filter = dto.filter;
    if (dto.segmentId) audience.segmentId = dto.segmentId;

    const ids = await this.resolveAudience(companyId, audience);
    const sample = await this.prisma.contact.findMany({
      where: { id: { in: ids.slice(0, 10) }, company_id: companyId },
      select: { id: true, name: true, phone: true },
    });
    return { count: ids.length, sample };
  }

  /**
   * Send ONE real template message to a single phone for previewing. Bypasses
   * the queue and never touches broadcast counters. Personalization tokens are
   * resolved against the matching contact if one exists for that phone.
   */
  async testSend(companyId: number, dto: TestSendDto) {
    const [company, template] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { phone_number_id: true },
      }),
      this.prisma.template.findFirst({
        where: { id: dto.templateId, company_id: companyId, deleted_at: null },
      }),
    ]);
    if (!company?.phone_number_id) {
      throw new BadRequestException('WhatsApp number is not configured yet');
    }
    if (!template?.meta_template_id) {
      throw new BadRequestException(
        'Template not found or not yet approved by Meta',
      );
    }

    await this.metaClient.assertOnboarded(companyId);

    const contact = await this.prisma.contact.findFirst({
      where: { phone: dto.phone, company_id: companyId, deleted_at: null },
      select: { name: true, phone: true, email: true, custom_fields: true },
    });
    const langCode =
      (template.content as { language?: string })?.language ?? 'en_US';
    const components = BroadcastsService.buildTemplateComponents(
      dto.variables ?? {},
      contact ?? { name: null, phone: dto.phone, email: null, custom_fields: {} },
    );
    await this.metaClient.sendTemplate(
      companyId,
      company.phone_number_id,
      dto.phone,
      template.name,
      langCode,
      components,
    );
    return { ok: true };
  }

  /** Clone a broadcast into a fresh draft ("Copy of …"). */
  async duplicate(companyId: number, id: number) {
    const b = await this.get(companyId, id);
    return this.prisma.broadcast.create({
      data: {
        company_id: companyId,
        template_id: b.template_id,
        name: `Copy of ${b.name}`.slice(0, 255),
        audience_filter: b.audience_filter as unknown as object,
        status: 'draft',
      },
    });
  }

  /**
   * Resolve a single variable value for a recipient. A value is either a
   * literal string or a contact token: `{{contact.name|phone|email}}` or
   * `{{contact.custom.<key>}}`.
   */
  static resolveVariableValue(
    raw: string,
    contact: PersonalizationContact,
  ): string {
    const m = /^\{\{\s*contact\.([a-zA-Z0-9_.]+)\s*\}\}$/.exec(raw ?? '');
    if (!m) return raw ?? '';
    const path = m[1];
    if (path === 'name') return contact.name ?? '';
    if (path === 'phone') return contact.phone ?? '';
    if (path === 'email') return contact.email ?? '';
    if (path.startsWith('custom.')) {
      const key = path.slice('custom.'.length);
      const cf = (contact.custom_fields ?? {}) as Record<string, unknown>;
      const v = cf[key];
      return v == null ? '' : String(v);
    }
    return '';
  }

  /** Build Meta `components` (body params), resolving tokens per recipient. */
  static buildTemplateComponents(
    variables: Record<string, string>,
    contact: PersonalizationContact,
  ): unknown[] {
    const entries = Object.entries(variables);
    if (entries.length === 0) return [];
    return [
      {
        type: 'body',
        parameters: entries
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, value]) => ({
            type: 'text',
            text: BroadcastsService.resolveVariableValue(value, contact),
          })),
      },
    ];
  }

  /**
   * Resolve audience and enqueue per-contact jobs with 100ms spacing.
   * Called either directly by /send or by the scheduler when run_at hits.
   */
  async dispatch(companyId: number, broadcastId: number): Promise<void> {
    const b = await this.prisma.broadcast.findFirst({
      where: { id: broadcastId, company_id: companyId },
    });
    if (!b) throw new NotFoundException('Broadcast not found');
    if (b.status === 'cancelled') return;

    const audience = b.audience_filter as Record<string, unknown>;
    const contactIds = await this.resolveAudience(companyId, audience);
    if (contactIds.length === 0) {
      await this.prisma.broadcast.update({
        where: { id: broadcastId },
        data: { status: 'completed' },
      });
      return;
    }

    await this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'sending' },
    });

    const variables = (audience.variables as Record<string, string>) ?? {};
    for (let i = 0; i < contactIds.length; i++) {
      await this.jobQueue.enqueue(
        'broadcast',
        {
          kind: 'send',
          broadcastId,
          companyId,
          contactId: contactIds[i],
          templateId: b.template_id,
          variables,
          total: contactIds.length,
        },
        { delayMs: i * THROTTLE_SPACING_MS },
      );
    }
  }

  private async resolveAudience(
    companyId: number,
    audience: Record<string, unknown>,
  ): Promise<number[]> {
    if (audience.all === true) {
      // Every active contact (blocked/archived excluded by the status filter).
      return this.segmentsService.resolveContacts(companyId, {
        status: 'active',
      } as SegmentFilterDto);
    }
    if (Array.isArray(audience.contactIds) && audience.contactIds.length > 0) {
      const ids = (audience.contactIds as number[]).filter(Number.isInteger);
      // verify tenant
      const verified = await this.prisma.contact.findMany({
        where: {
          id: { in: ids },
          company_id: companyId,
          deleted_at: null,
        },
        select: { id: true },
      });
      return verified.map((c) => c.id);
    }
    if (audience.segmentId) {
      const seg = await this.segmentsService.get(companyId, audience.segmentId as number);
      return this.segmentsService.resolveContacts(
        companyId,
        seg.filter as Record<string, unknown>,
      );
    }
    if (audience.filter) {
      return this.segmentsService.resolveContacts(
        companyId,
        audience.filter as Record<string, unknown>,
      );
    }
    return [];
  }

  private async resolveAudienceSize(
    companyId: number,
    audience: Record<string, unknown>,
  ): Promise<number> {
    const ids = await this.resolveAudience(companyId, audience);
    return ids.length;
  }

  /**
   * Atomic increment for sent/failed/etc — called from the worker.
   */
  async incrementCounters(
    broadcastId: number,
    field: 'sent_count' | 'failed_count',
  ): Promise<{ sent_count: number; failed_count: number; total: number | null }> {
    const updated = await this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: { [field]: { increment: 1 } },
      select: { sent_count: true, failed_count: true, audience_filter: true },
    });
    const audience = updated.audience_filter as Record<string, unknown>;
    const total =
      Array.isArray(audience.contactIds)
        ? (audience.contactIds as number[]).length
        : null;
    return {
      sent_count: updated.sent_count,
      failed_count: updated.failed_count,
      total,
    };
  }

  async markCompletedIfDone(
    broadcastId: number,
    total: number,
  ): Promise<boolean> {
    const b = await this.prisma.broadcast.findUnique({
      where: { id: broadcastId },
      select: { sent_count: true, failed_count: true, status: true },
    });
    if (!b) return false;
    if (b.sent_count + b.failed_count >= total && b.status === 'sending') {
      await this.prisma.broadcast.update({
        where: { id: broadcastId },
        data: { status: 'completed' },
      });
      return true;
    }
    return false;
  }

  /**
   * For the worker's "every 25 jobs" progress emit check.
   */
  static shouldEmitProgress(processed: number): boolean {
    return processed > 0 && processed % PROGRESS_EMIT_EVERY === 0;
  }
}
