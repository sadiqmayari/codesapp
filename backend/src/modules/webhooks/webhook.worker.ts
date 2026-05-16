import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { WebhookDeliveryService } from './webhook-delivery.service';

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

interface RawWebhookPayload {
  webhookEndpointId?: number;
  event?: string;
  companyId?: number;
  data?: unknown;
  enqueuedAt?: string;
}

@Injectable()
export class WebhookWorker implements OnModuleInit {
  private readonly logger = new Logger(WebhookWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobQueue: JobQueueService,
    private readonly encryption: EncryptionService,
    private readonly delivery: WebhookDeliveryService,
  ) {}

  onModuleInit(): void {
    this.jobQueue.registerWorker('webhook', (p) => this.handle(p), 3);
    this.logger.log('Registered webhook worker (concurrency=3)');
  }

  async handle(rawPayload: unknown): Promise<void> {
    const p = (rawPayload ?? {}) as RawWebhookPayload;
    const endpointId = p.webhookEndpointId;
    const event = p.event ?? 'unknown';
    // Legacy Phase 2 bot jobs nested companyId inside `data`.
    const dataObj = (p.data ?? {}) as { companyId?: number };
    const companyId = p.companyId ?? dataObj.companyId ?? 0;

    if (!endpointId) {
      // Nothing actionable — record and consume the job.
      await this.delivery.writeLog({
        webhookId: 0,
        companyId,
        event,
        payload: p,
        deliveryStatus: 'failed',
        attempts: 1,
        reason: 'endpoint_inactive_or_missing',
      });
      return;
    }

    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id: endpointId },
    });

    // (a) endpoint missing OR not active → log + consume (do NOT throw)
    if (!endpoint || endpoint.status !== 'active') {
      await this.delivery.writeLog({
        webhookId: endpointId,
        companyId: endpoint?.company_id ?? companyId,
        event,
        payload: p,
        deliveryStatus: 'failed',
        attempts: 1,
        reason: 'endpoint_inactive_or_missing',
      });
      return;
    }

    const resolvedCompanyId = endpoint.company_id;

    // (b) stale → drain. Phase 2 backlog jobs carry no `enqueuedAt`; treat a
    // missing or >7d-old timestamp as stale so the backlog is consumed, not
    // retried forever.
    const enqueuedMs = p.enqueuedAt ? Date.parse(p.enqueuedAt) : NaN;
    const isStale =
      Number.isNaN(enqueuedMs) || Date.now() - enqueuedMs > STALE_MS;
    if (isStale) {
      await this.delivery.writeLog({
        webhookId: endpointId,
        companyId: resolvedCompanyId,
        event,
        payload: p,
        deliveryStatus: 'failed',
        attempts: 1,
        reason: 'stale',
      });
      return;
    }

    // (c) decrypt secret
    let secret: string;
    try {
      secret = this.encryption.decrypt(endpoint.secret_key_encrypted);
    } catch {
      await this.delivery.writeLog({
        webhookId: endpointId,
        companyId: resolvedCompanyId,
        event,
        payload: p,
        deliveryStatus: 'failed',
        attempts: 1,
        reason: 'secret_decrypt_failed',
      });
      return;
    }

    // (d) build payload
    const deliveryId = uuidv4();
    const built = WebhookDeliveryService.buildPayload(
      event,
      resolvedCompanyId,
      p.data,
      deliveryId,
    );
    const rawBody = JSON.stringify(built);

    // (e) sign
    const signature = WebhookDeliveryService.sign(rawBody, secret);

    // (h) every attempt counts as a webhook call
    await this.delivery.incrementWebhookCall(resolvedCompanyId);

    // (f) POST
    let status: number;
    try {
      const res = await this.delivery.post(
        endpoint.endpoint_url,
        {
          'content-type': 'application/json',
          'x-codesapp-signature': signature,
          'x-codesapp-event': event,
          'x-codesapp-delivery': deliveryId,
          'x-codesapp-timestamp': built.timestamp,
        },
        rawBody,
      );
      status = res.status;
    } catch (err) {
      // network / timeout → attempt logged, throw so the queue backs off
      await this.delivery.writeLog({
        webhookId: endpointId,
        companyId: resolvedCompanyId,
        event,
        payload: built,
        deliveryStatus: 'failed',
        attempts: 1,
        reason: 'network_error',
      });
      throw err instanceof Error ? err : new Error(String(err));
    }

    const outcome = WebhookDeliveryService.classify(status);
    if (outcome === 'success') {
      await this.delivery.writeLog({
        webhookId: endpointId,
        companyId: resolvedCompanyId,
        event,
        payload: built,
        deliveryStatus: 'success',
        httpStatus: status,
        attempts: 1,
      });
      return;
    }

    if (outcome === 'client_error') {
      await this.delivery.writeLog({
        webhookId: endpointId,
        companyId: resolvedCompanyId,
        event,
        payload: built,
        deliveryStatus: 'failed',
        httpStatus: status,
        attempts: 1,
        reason: 'client_error',
      });
      return;
    }

    // retry: log the attempt then throw so JobQueueService backs off
    await this.delivery.writeLog({
      webhookId: endpointId,
      companyId: resolvedCompanyId,
      event,
      payload: built,
      deliveryStatus: 'failed',
      httpStatus: status,
      attempts: 1,
      reason: 'server_error',
    });
    throw new Error(
      `Webhook ${endpointId} delivery failed with retryable status ${status}`,
    );
  }
}
