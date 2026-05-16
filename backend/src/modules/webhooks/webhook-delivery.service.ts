import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

const REQUEST_TIMEOUT_MS = 10_000;

export type DeliveryOutcome = 'success' | 'client_error' | 'retry';

export interface BuiltWebhookPayload {
  event: string;
  delivery_id: string;
  timestamp: string;
  company_id: number;
  data: unknown;
}

export interface HttpResult {
  status: number;
}

@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `sha256=<hex>` of HMAC-SHA256(rawJsonBody, secret). Pure — unit tested.
   */
  static sign(rawJsonBody: string, secret: string): string {
    const hex = crypto
      .createHmac('sha256', secret)
      .update(rawJsonBody, 'utf8')
      .digest('hex');
    return `sha256=${hex}`;
  }

  /**
   * Status-code → policy. Pure — unit tested.
   * 2xx success. 3xx/4xx (except 408,429) client_error (do not retry).
   * 5xx / 408 / 429 retry (throw so the queue applies backoff).
   */
  static classify(status: number): DeliveryOutcome {
    if (status >= 200 && status < 300) return 'success';
    if (status === 408 || status === 429) return 'retry';
    if (status >= 300 && status < 500) return 'client_error';
    return 'retry';
  }

  static buildPayload(
    event: string,
    companyId: number,
    data: unknown,
    deliveryId: string,
  ): BuiltWebhookPayload {
    return {
      event,
      delivery_id: deliveryId,
      timestamp: new Date().toISOString(),
      company_id: companyId,
      data,
    };
  }

  /**
   * POST with Node native https. 10s timeout, no keepalive agent.
   * Resolves with the HTTP status. Rejects on network error / timeout
   * (caller treats a rejection as a retry).
   */
  post(
    endpointUrl: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(endpointUrl);
      } catch {
        reject(new Error(`Invalid webhook URL: ${endpointUrl}`));
        return;
      }

      const req = https.request(
        {
          host: u.host,
          path: `${u.pathname}${u.search}`,
          method: 'POST',
          headers: {
            ...headers,
            'content-length': Buffer.byteLength(body).toString(),
          },
          timeout: REQUEST_TIMEOUT_MS,
          agent: false, // no keepalive
        },
        (res) => {
          // Drain so the socket frees; we only care about the status code.
          res.on('data', () => undefined);
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        },
      );

      req.on('timeout', () =>
        req.destroy(new Error('Webhook delivery timed out')),
      );
      req.on('error', (err) => reject(err));
      req.write(body);
      req.end();
    });
  }

  /**
   * Atomically bump usage_metering.webhook_calls for the company's current
   * period. Direct raw SQL (no UsageMeteringService) so the webhook queue
   * never recurses into the limit-warning → dispatcher path.
   */
  async incrementWebhookCall(companyId: number): Promise<void> {
    const period = new Date().toISOString().slice(0, 7);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO usage_metering (company_id, period, webhook_calls, updated_at)
       VALUES (?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE webhook_calls = webhook_calls + 1, updated_at = NOW()`,
      companyId,
      period,
    );
  }

  async writeLog(params: {
    webhookId: number;
    companyId: number;
    event: string;
    payload: unknown;
    deliveryStatus: 'success' | 'failed' | 'pending';
    httpStatus?: number | null;
    attempts: number;
    reason?: string;
  }): Promise<void> {
    await this.prisma.webhookLog.create({
      data: {
        webhook_id: params.webhookId,
        company_id: params.companyId,
        event_name: params.event,
        payload: {
          payload: params.payload,
          reason: params.reason ?? null,
        } as object,
        delivery_status: params.deliveryStatus,
        http_status: params.httpStatus ?? null,
        attempts: params.attempts,
      },
    });
  }
}
