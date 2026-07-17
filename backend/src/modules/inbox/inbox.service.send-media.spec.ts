import * as fs from 'fs';
import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InboxService } from './inbox.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { InboxGateway } from './inbox.gateway';
import { MetaClientService } from './meta-client.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';

function build(opts: { windowOpen: boolean }) {
  const convo = {
    id: 10,
    company_id: 1,
    contact_id: 5,
    window_expires_at: new Date(
      Date.now() + (opts.windowOpen ? 3600_000 : -3600_000),
    ),
  };
  const created: Record<string, unknown>[] = [];
  const prisma = {
    conversation: {
      findFirst: jest.fn().mockResolvedValue(convo),
      update: jest.fn().mockResolvedValue({}),
    },
    company: {
      findUnique: jest.fn().mockResolvedValue({ phone_number_id: 'PNID' }),
    },
    contact: {
      findUnique: jest.fn().mockResolvedValue({ phone: '15551234567' }),
    },
    message: {
      create: jest.fn().mockImplementation((args: { data: object }) => {
        const row = { id: 99, ...args.data };
        created.push(row);
        return Promise.resolve(row);
      }),
    },
  } as unknown as PrismaService;

  const metering = {
    incrementMessages: jest.fn().mockResolvedValue(undefined),
  } as unknown as UsageMeteringService;
  const gateway = {
    emitToCompany: jest.fn(),
    emitToConversationScoped: jest.fn(),
  } as unknown as InboxGateway;
  const metaClient = {
    assertOnboarded: jest.fn().mockResolvedValue(undefined),
    uploadMedia: jest.fn().mockResolvedValue({ mediaId: 'MEDIA-1' }),
    sendMessage: jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.X' }] }),
  } as unknown as MetaClientService;
  const config = {} as unknown as ConfigService;
  const webhook = {
    dispatch: jest.fn().mockResolvedValue(undefined),
  } as unknown as WebhookDispatcherService;
  const companyStatus = {
    isActive: jest.fn().mockResolvedValue(true),
  } as unknown as import('../../common/services/company-status.service').CompanyStatusService;

  const jobQueue = {
    enqueue: jest.fn().mockResolvedValue(1),
    registerWorker: jest.fn(),
  } as unknown as import('../../common/services/job-queue.service').JobQueueService;

  const service = new InboxService(
    prisma,
    metering,
    gateway,
    metaClient,
    config,
    webhook,
    companyStatus,
    {} as unknown as import('../ai/audio-transcription.service').AudioTranscriptionService,
    {} as unknown as import('../ai/ai-metering.service').AiMeteringService,
    jobQueue,
  );
  return { service, prisma, metaClient, jobQueue, created };
}

describe('InboxService.sendMedia', () => {
  beforeEach(() => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as never);
    // sendMedia now writes/copies media asynchronously (fs.promises) so a large
    // disk write never blocks the Node event loop / other requests.
    jest.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
    jest.spyOn(fs.promises, 'copyFile').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('throws 403 when the 24hr window is closed', async () => {
    const { service } = build({ windowOpen: false });
    await expect(
      service.sendMedia({
        companyId: 1,
        conversationId: 10,
        file: {
          buffer: Buffer.from('x'),
          mimetype: 'image/png',
          originalname: 'a.png',
          size: 1,
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws 400 for an oversized image', async () => {
    const { service } = build({ windowOpen: true });
    await expect(
      service.sendMedia({
        companyId: 1,
        conversationId: 10,
        file: {
          buffer: Buffer.from('x'),
          mimetype: 'image/png',
          originalname: 'big.png',
          size: 6 * 1024 * 1024,
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('image happy path persists a `sending` row and enqueues delivery (no inline Meta call)', async () => {
    const { service, metaClient, jobQueue, created } = build({
      windowOpen: true,
    });
    const msg = await service.sendMedia({
      companyId: 1,
      conversationId: 10,
      file: {
        buffer: Buffer.from('hello'),
        mimetype: 'image/jpeg',
        originalname: 'photo.jpg',
        size: 5,
      },
      caption: 'hi there',
    });
    // The request path must NOT block on Meta — upload+send happen on the queue.
    expect(metaClient.uploadMedia).not.toHaveBeenCalled();
    expect(metaClient.sendMessage).not.toHaveBeenCalled();
    expect(created).toHaveLength(1);
    const row = created[0] as Record<string, unknown>;
    expect(row.direction).toBe('outbound');
    expect(row.message_type).toBe('image');
    expect(row.content).toBe('hi there');
    expect(row.status).toBe('sending');
    expect(row.meta_message_id).toBeNull();
    expect(String(row.media_url)).toMatch(
      /^\/storage\/media\/1\/\d{4}\/\d{2}\/[\w-]+\.jpg$/,
    );
    expect((msg as { media_url?: string }).media_url).toBe(row.media_url);
    // A send-media job was enqueued for this row, FIFO per chat, delivered once.
    expect(jobQueue.enqueue).toHaveBeenCalledWith(
      'send-media',
      expect.objectContaining({ messageId: 99, conversationId: 10 }),
      expect.objectContaining({
        serialKey: 'media:conv:10',
        dedupKey: 'send-media:99',
        maxAttempts: 1,
      }),
    );
  });
});
