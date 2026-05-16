import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { InboxGateway } from '../inbox/inbox.gateway';
import { MetaClientService } from '../inbox/meta-client.service';
import { BroadcastsService } from './broadcasts.service';

interface BroadcastSendPayload {
  kind: 'send';
  broadcastId: number;
  companyId: number;
  contactId: number;
  templateId: number;
  variables?: Record<string, string>;
  total: number;
}

interface BroadcastDispatchPayload {
  kind: 'dispatch';
  broadcastId: number;
  companyId: number;
}

type BroadcastJobPayload = BroadcastSendPayload | BroadcastDispatchPayload;

@Injectable()
export class BroadcastWorker implements OnModuleInit {
  private readonly logger = new Logger(BroadcastWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly broadcasts: BroadcastsService,
    private readonly metaClient: MetaClientService,
    private readonly gateway: InboxGateway,
  ) {}

  onModuleInit(): void {
    this.jobQueue.registerWorker(
      'broadcast',
      (p) => this.handle(p as BroadcastJobPayload),
      3,
    );
    this.logger.log('Registered broadcast worker (concurrency=3)');
  }

  async handle(payload: BroadcastJobPayload): Promise<void> {
    if (payload?.kind === 'dispatch') {
      await this.broadcasts.dispatch(payload.companyId, payload.broadcastId);
      return;
    }
    if (payload?.kind !== 'send') return;

    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id: payload.broadcastId },
    });
    if (!broadcast || broadcast.status === 'cancelled') return;

    const [company, contact, template] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: payload.companyId },
        select: { phone_number_id: true },
      }),
      this.prisma.contact.findFirst({
        where: { id: payload.contactId, company_id: payload.companyId },
      }),
      this.prisma.template.findFirst({
        where: {
          id: payload.templateId,
          company_id: payload.companyId,
          deleted_at: null,
        },
      }),
    ]);

    if (!company?.phone_number_id || !contact || !template?.meta_template_id) {
      await this.broadcasts.incrementCounters(payload.broadcastId, 'failed_count');
      return;
    }

    try {
      await this.metaClient.assertOnboarded(payload.companyId);
      const langCode =
        (template.content as { language?: string })?.language ?? 'en_US';
      const components = this.buildComponents(payload.variables ?? {});
      const response = await this.metaClient.sendTemplate(
        payload.companyId,
        company.phone_number_id,
        contact.phone,
        template.name,
        langCode,
        components,
      );
      const metaMessageId = response.messages?.[0]?.id ?? null;

      // Find or create a conversation
      let convo = await this.prisma.conversation.findFirst({
        where: {
          company_id: payload.companyId,
          contact_id: contact.id,
          deleted_at: null,
        },
        orderBy: { id: 'desc' },
      });
      if (!convo) {
        convo = await this.prisma.conversation.create({
          data: {
            company_id: payload.companyId,
            contact_id: contact.id,
            status: 'open',
          },
        });
      }

      await this.prisma.message.create({
        data: {
          conversation_id: convo.id,
          company_id: payload.companyId,
          broadcast_id: payload.broadcastId,
          message_type: 'template',
          direction: 'outbound',
          content: `[template:${template.name}]`,
          status: 'sent',
          meta_message_id: metaMessageId,
          timestamp: new Date(),
        },
      });

      const counters = await this.broadcasts.incrementCounters(
        payload.broadcastId,
        'sent_count',
      );
      const processed = counters.sent_count + counters.failed_count;

      if (BroadcastsService.shouldEmitProgress(processed)) {
        this.gateway.emitToCompany(payload.companyId, 'broadcast.progress', {
          broadcastId: payload.broadcastId,
          sent: counters.sent_count,
          failed: counters.failed_count,
          total: payload.total,
        });
      }

      const done = await this.broadcasts.markCompletedIfDone(
        payload.broadcastId,
        payload.total,
      );
      if (done) {
        this.gateway.emitToCompany(payload.companyId, 'broadcast.progress', {
          broadcastId: payload.broadcastId,
          sent: counters.sent_count,
          failed: counters.failed_count,
          total: payload.total,
          status: 'completed',
        });
      }
    } catch (err) {
      const counters = await this.broadcasts.incrementCounters(
        payload.broadcastId,
        'failed_count',
      );
      this.logger.warn(
        `Broadcast send failed for broadcast=${payload.broadcastId} contact=${payload.contactId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await this.broadcasts.markCompletedIfDone(payload.broadcastId, payload.total);
      // Re-throw so JobQueueService records the failure and retries
      void counters;
      throw err;
    }
  }

  private buildComponents(variables: Record<string, string>): unknown[] {
    const entries = Object.entries(variables);
    if (entries.length === 0) return [];
    return [
      {
        type: 'body',
        parameters: entries
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([, value]) => ({ type: 'text', text: value })),
      },
    ];
  }
}
