import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import {
  WebhookDispatcherService,
  WebhookJobPayload,
} from './webhook-dispatcher.service';
import { CreateEndpointDto } from './dtos/create-endpoint.dto';
import { UpdateEndpointDto } from './dtos/update-endpoint.dto';
import { ListLogsDto } from './dtos/list-logs.dto';

const DEFAULT_PAGE_SIZE = 20;

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly jobQueue: JobQueueService,
    private readonly dispatcher: WebhookDispatcherService,
  ) {}

  private sanitize(ep: {
    id: number;
    company_id: number;
    endpoint_url: string;
    events: unknown;
    status: string;
    created_at: Date;
  }) {
    return {
      id: ep.id,
      company_id: ep.company_id,
      endpoint_url: ep.endpoint_url,
      events: ep.events,
      status: ep.status,
      secret: '(set)',
      created_at: ep.created_at,
    };
  }

  async listEndpoints(companyId: number, page = 1, limit = DEFAULT_PAGE_SIZE) {
    const skip = (page - 1) * limit;
    const [total, rows] = await Promise.all([
      this.prisma.webhookEndpoint.count({ where: { company_id: companyId } }),
      this.prisma.webhookEndpoint.findMany({
        where: { company_id: companyId },
        orderBy: { id: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    return {
      success: true,
      data: rows.map((r) => this.sanitize(r)),
      message: 'OK',
      meta: { page, limit, total },
    };
  }

  async getEndpoint(companyId: number, id: number) {
    const ep = await this.requireEndpoint(companyId, id);
    return this.sanitize(ep);
  }

  /**
   * The outbound-webhook feature is plan-gated (`subscriptions.webhook_enabled`).
   * Enforced on every action that creates or fires a delivery; read-only list
   * endpoints stay open so a downgraded tenant can still see/clean up old config.
   */
  private async assertWebhookFeature(companyId: number) {
    if (!(await this.dispatcher.isWebhookFeatureEnabled(companyId))) {
      throw new ForbiddenException(
        'Webhooks are not included in your current plan. Contact support to upgrade.',
      );
    }
  }

  async createEndpoint(companyId: number, dto: CreateEndpointDto) {
    await this.assertWebhookFeature(companyId);
    if (!/^https:\/\//i.test(dto.endpointUrl)) {
      throw new BadRequestException('endpointUrl must be https');
    }
    const ep = await this.prisma.webhookEndpoint.create({
      data: {
        company_id: companyId,
        endpoint_url: dto.endpointUrl,
        secret_key_encrypted: this.encryption.encrypt(dto.secret),
        events: dto.events as Prisma.InputJsonValue,
        status: dto.status === 'inactive' ? 'inactive' : 'active',
      },
    });
    this.dispatcher.invalidate(companyId);
    return this.sanitize(ep);
  }

  async updateEndpoint(
    companyId: number,
    id: number,
    dto: UpdateEndpointDto,
  ) {
    await this.requireEndpoint(companyId, id);
    if (dto.status === 'active') await this.assertWebhookFeature(companyId);
    if (dto.endpointUrl && !/^https:\/\//i.test(dto.endpointUrl)) {
      throw new BadRequestException('endpointUrl must be https');
    }
    const data: Prisma.WebhookEndpointUpdateInput = {};
    if (dto.endpointUrl !== undefined) data.endpoint_url = dto.endpointUrl;
    if (dto.secret !== undefined) {
      data.secret_key_encrypted = this.encryption.encrypt(dto.secret);
    }
    if (dto.events !== undefined) {
      data.events = dto.events as Prisma.InputJsonValue;
    }
    if (dto.status !== undefined) data.status = dto.status;

    const ep = await this.prisma.webhookEndpoint.update({
      where: { id },
      data,
    });
    this.dispatcher.invalidate(companyId);
    return this.sanitize(ep);
  }

  async deleteEndpoint(companyId: number, id: number) {
    await this.requireEndpoint(companyId, id);
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    this.dispatcher.invalidate(companyId);
    return { ok: true };
  }

  async toggleEndpoint(companyId: number, id: number) {
    const ep = await this.requireEndpoint(companyId, id);
    const next = ep.status === 'active' ? 'inactive' : 'active';
    if (next === 'active') await this.assertWebhookFeature(companyId);
    const updated = await this.prisma.webhookEndpoint.update({
      where: { id },
      data: { status: next },
    });
    this.dispatcher.invalidate(companyId);
    return this.sanitize(updated);
  }

  async testEndpoint(companyId: number, id: number) {
    await this.assertWebhookFeature(companyId);
    const ep = await this.requireEndpoint(companyId, id);
    const payload: WebhookJobPayload = {
      webhookEndpointId: ep.id,
      event: 'test',
      companyId,
      data: { message: 'CodesApp webhook test event', endpointId: ep.id },
      enqueuedAt: new Date().toISOString(),
    };
    const jobId = await this.jobQueue.enqueue('webhook', payload);
    return { enqueued: true, jobId };
  }

  async listLogs(companyId: number, dto: ListLogsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    const skip = (page - 1) * limit;

    const where: Prisma.WebhookLogWhereInput = { company_id: companyId };
    if (dto.endpointId) where.webhook_id = dto.endpointId;
    if (dto.event) where.event_name = dto.event;
    if (dto.status) where.delivery_status = dto.status;
    if (dto.from || dto.to) {
      where.created_at = {};
      if (dto.from) where.created_at.gte = new Date(dto.from);
      if (dto.to) where.created_at.lte = new Date(dto.to);
    }

    const [total, rows] = await Promise.all([
      this.prisma.webhookLog.count({ where }),
      this.prisma.webhookLog.findMany({
        where,
        orderBy: { id: 'desc' },
        skip,
        take: limit,
      }),
    ]);
    return {
      success: true,
      data: rows,
      message: 'OK',
      meta: { page, limit, total },
    };
  }

  async retryLog(companyId: number, logId: number) {
    await this.assertWebhookFeature(companyId);
    const log = await this.prisma.webhookLog.findFirst({
      where: { id: logId, company_id: companyId },
    });
    if (!log) throw new NotFoundException('Webhook log not found');

    const stored = (log.payload ?? {}) as {
      payload?: { data?: unknown };
    };
    const data = stored.payload?.data ?? {};

    const payload: WebhookJobPayload = {
      webhookEndpointId: log.webhook_id,
      event: log.event_name,
      companyId,
      data,
      enqueuedAt: new Date().toISOString(),
    };
    const jobId = await this.jobQueue.enqueue('webhook', payload);
    return { reEnqueued: true, jobId };
  }

  private async requireEndpoint(companyId: number, id: number) {
    const ep = await this.prisma.webhookEndpoint.findFirst({
      where: { id, company_id: companyId },
    });
    if (!ep) throw new NotFoundException('Webhook endpoint not found');
    return ep;
  }
}
