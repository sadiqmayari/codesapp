import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { MetaWebhookController } from './meta-webhook.controller';
import { JobQueueService } from '../../common/services/job-queue.service';

interface MockResponse {
  statusCode?: number;
  contentType?: string;
  bodyText?: string;
  bodyJson?: unknown;
  status: (code: number) => MockResponse;
  type: (t: string) => MockResponse;
  send: (b: string) => void;
  json: (b: unknown) => void;
}

function makeRes(): MockResponse {
  const res: MockResponse = {
    status: (code: number) => {
      res.statusCode = code;
      return res;
    },
    type: (t: string) => {
      res.contentType = t;
      return res;
    },
    send: (b: string) => {
      res.bodyText = b;
    },
    json: (b: unknown) => {
      res.bodyJson = b;
    },
  };
  return res;
}

describe('MetaWebhookController', () => {
  const APP_SECRET = 'test-app-secret';
  const VERIFY_TOKEN = 'verify-me';

  let controller: MetaWebhookController;
  let enqueued: Array<{ queue: string; payload: unknown }>;

  beforeEach(() => {
    enqueued = [];
    const config = {
      get: (k: string) => {
        if (k === 'META_APP_SECRET') return APP_SECRET;
        if (k === 'META_VERIFY_TOKEN') return VERIFY_TOKEN;
        return undefined;
      },
    } as unknown as ConfigService;
    const jobQueue = {
      enqueue: async (queue: string, payload: unknown) => {
        enqueued.push({ queue, payload });
        return 1;
      },
    } as unknown as JobQueueService;
    controller = new MetaWebhookController(config, jobQueue);
  });

  describe('GET verify', () => {
    it('responds with plain-text challenge on valid token', () => {
      const res = makeRes();
      controller.verify('subscribe', VERIFY_TOKEN, 'challenge-123', res as never);
      expect(res.statusCode).toBe(200);
      expect(res.contentType).toBe('text/plain');
      expect(res.bodyText).toBe('challenge-123');
    });

    it('responds 403 on token mismatch', () => {
      const res = makeRes();
      controller.verify('subscribe', 'wrong-token', 'c', res as never);
      expect(res.statusCode).toBe(403);
      expect(res.contentType).toBe('text/plain');
    });
  });

  describe('verifySignature', () => {
    it('accepts a matching HMAC signature', () => {
      const body = Buffer.from('{"hello":"world"}');
      const sig =
        'sha256=' +
        crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
      expect(controller.verifySignature(sig, body, APP_SECRET)).toBe(true);
    });

    it('rejects a tampered HMAC signature', () => {
      const body = Buffer.from('{"hello":"world"}');
      const sig =
        'sha256=' +
        crypto.createHmac('sha256', 'WRONG-secret').update(body).digest('hex');
      expect(controller.verifySignature(sig, body, APP_SECRET)).toBe(false);
    });

    it('handles signature header without the sha256= prefix', () => {
      const body = Buffer.from('payload');
      const sig = crypto
        .createHmac('sha256', APP_SECRET)
        .update(body)
        .digest('hex');
      expect(controller.verifySignature(sig, body, APP_SECRET)).toBe(true);
    });
  });
});
