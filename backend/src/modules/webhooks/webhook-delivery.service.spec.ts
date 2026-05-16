import * as crypto from 'crypto';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookWorker } from './webhook.worker';

describe('WebhookDeliveryService — pure helpers', () => {
  it('signs with HMAC-SHA256 and the sha256= prefix', () => {
    const body = JSON.stringify({ hello: 'world' });
    const secret = 'super-secret-key';
    const expected =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(WebhookDeliveryService.sign(body, secret)).toBe(expected);
  });

  it('produces a different signature when the secret differs', () => {
    const body = '{"a":1}';
    expect(WebhookDeliveryService.sign(body, 's1')).not.toBe(
      WebhookDeliveryService.sign(body, 's2'),
    );
  });

  it('classifies 2xx as success', () => {
    expect(WebhookDeliveryService.classify(200)).toBe('success');
    expect(WebhookDeliveryService.classify(204)).toBe('success');
  });

  it('classifies 3xx/4xx (except 408,429) as client_error (no retry)', () => {
    expect(WebhookDeliveryService.classify(301)).toBe('client_error');
    expect(WebhookDeliveryService.classify(400)).toBe('client_error');
    expect(WebhookDeliveryService.classify(404)).toBe('client_error');
  });

  it('classifies 5xx / 408 / 429 as retry', () => {
    expect(WebhookDeliveryService.classify(500)).toBe('retry');
    expect(WebhookDeliveryService.classify(502)).toBe('retry');
    expect(WebhookDeliveryService.classify(408)).toBe('retry');
    expect(WebhookDeliveryService.classify(429)).toBe('retry');
  });

  it('builds the canonical payload shape', () => {
    const p = WebhookDeliveryService.buildPayload('test', 7, { x: 1 }, 'dlv-1');
    expect(p.event).toBe('test');
    expect(p.company_id).toBe(7);
    expect(p.delivery_id).toBe('dlv-1');
    expect(p.data).toEqual({ x: 1 });
    expect(typeof p.timestamp).toBe('string');
  });
});

describe('WebhookWorker — skip policies (no throw → job consumed)', () => {
  function makeWorker(overrides: {
    endpoint?: unknown;
  }) {
    const writeLog = jest.fn().mockResolvedValue(undefined);
    const post = jest.fn();
    const incrementWebhookCall = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      webhookEndpoint: {
        findUnique: jest.fn().mockResolvedValue(overrides.endpoint ?? null),
      },
    };
    const jobQueue = { registerWorker: jest.fn() };
    const encryption = { decrypt: jest.fn().mockReturnValue('secret') };
    const delivery = { writeLog, post, incrementWebhookCall };
    const worker = new WebhookWorker(
      prisma as never,
      jobQueue as never,
      encryption as never,
      delivery as never,
    );
    return { worker, writeLog, post };
  }

  it('inactive/missing endpoint → logs failed, does NOT throw or POST', async () => {
    const { worker, writeLog, post } = makeWorker({ endpoint: null });
    await expect(
      worker.handle({
        webhookEndpointId: 5,
        event: 'message.sent',
        companyId: 1,
        enqueuedAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
    expect(post).not.toHaveBeenCalled();
    expect(writeLog).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'endpoint_inactive_or_missing' }),
    );
  });

  it('stale job (no enqueuedAt) → logs failed reason=stale, no POST', async () => {
    const { worker, writeLog, post } = makeWorker({
      endpoint: {
        id: 5,
        company_id: 1,
        status: 'active',
        endpoint_url: 'https://x.test/hook',
        secret_key_encrypted: 'enc',
      },
    });
    await expect(
      worker.handle({
        webhookEndpointId: 5,
        event: 'keyword.triggered',
        data: { companyId: 1 },
      }),
    ).resolves.toBeUndefined();
    expect(post).not.toHaveBeenCalled();
    expect(writeLog).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'stale' }),
    );
  });
});
