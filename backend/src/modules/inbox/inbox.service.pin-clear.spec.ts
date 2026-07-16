import { ConfigService } from '@nestjs/config';
import { InboxService } from './inbox.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { InboxGateway } from './inbox.gateway';
import { MetaClientService } from './meta-client.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';

function build(convoOverrides: Record<string, unknown> = {}) {
  const convo = {
    id: 10,
    company_id: 1,
    contact_id: 5,
    pinned_at: null,
    cleared_before: null,
    ...convoOverrides,
  };
  const updates: Record<string, unknown>[] = [];
  let lastFindManyArgs: Record<string, unknown> | undefined;
  const prisma = {
    conversation: {
      findFirst: jest.fn().mockResolvedValue(convo),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockImplementation((args: Record<string, unknown>) => {
        lastFindManyArgs = args;
        return Promise.resolve([]);
      }),
      update: jest.fn().mockImplementation((args: { data: object }) => {
        updates.push(args.data as Record<string, unknown>);
        return Promise.resolve({ id: 10, ...args.data });
      }),
    },
    message: {
      findMany: jest.fn().mockImplementation((args: Record<string, unknown>) => {
        lastFindManyArgs = args;
        return Promise.resolve([]);
      }),
    },
  } as unknown as PrismaService;

  const gateway = { emitToCompany: jest.fn() } as unknown as InboxGateway;
  const service = new InboxService(
    prisma,
    {} as unknown as UsageMeteringService,
    gateway,
    {} as unknown as MetaClientService,
    {} as unknown as ConfigService,
    {} as unknown as WebhookDispatcherService,
    {
      isActive: jest.fn().mockResolvedValue(true),
    } as unknown as import('../../common/services/company-status.service').CompanyStatusService,
    {} as unknown as import('../ai/audio-transcription.service').AudioTranscriptionService,
    {} as unknown as import('../ai/ai-metering.service').AiMeteringService,
    {
      enqueue: jest.fn(),
      registerWorker: jest.fn(),
    } as unknown as import('../../common/services/job-queue.service').JobQueueService,
  );
  return {
    service,
    gateway,
    updates,
    getFindManyArgs: () => lastFindManyArgs,
  };
}

describe('InboxService.setPinned', () => {
  it('pins by stamping pinned_at and emits conversation.updated', async () => {
    const { service, updates, gateway } = build();
    await service.setPinned(1, 10, true);
    expect(updates[0].pinned_at).toBeInstanceOf(Date);
    expect(gateway.emitToCompany).toHaveBeenCalledWith(
      1,
      'conversation.updated',
      { conversationId: 10 },
    );
  });

  it('unpins by nulling pinned_at', async () => {
    const { service, updates } = build({ pinned_at: new Date() });
    await service.setPinned(1, 10, false);
    expect(updates[0]).toEqual({ pinned_at: null });
  });
});

describe('InboxService.clearHistory', () => {
  it('sets cleared_before to a Date and emits conversation.updated', async () => {
    const { service, updates, gateway } = build();
    await service.clearHistory(1, 10);
    expect(updates[0].cleared_before).toBeInstanceOf(Date);
    expect(gateway.emitToCompany).toHaveBeenCalledWith(
      1,
      'conversation.updated',
      { conversationId: 10 },
    );
  });
});

describe('InboxService.listConversations ordering', () => {
  it('orders pinned conversations first', async () => {
    const { service, getFindManyArgs } = build();
    await service.listConversations(1, {} as never, {
      userId: 1,
      role: 'owner',
    });
    const args = getFindManyArgs() as { orderBy: Array<Record<string, string>> };
    expect(args.orderBy[0]).toEqual({ pinned_at: 'desc' });
  });
});

describe('InboxService.listMessages clear marker', () => {
  it('filters out messages at/before cleared_before', async () => {
    const cleared = new Date('2026-05-01T00:00:00.000Z');
    const { service, getFindManyArgs } = build({ cleared_before: cleared });
    await service.listMessages(1, 10, undefined, 50);
    const args = getFindManyArgs() as {
      where: { timestamp?: { gt: Date } };
    };
    expect(args.where.timestamp).toEqual({ gt: cleared });
  });

  it('does not filter when cleared_before is null', async () => {
    const { service, getFindManyArgs } = build({ cleared_before: null });
    await service.listMessages(1, 10, undefined, 50);
    const args = getFindManyArgs() as { where: Record<string, unknown> };
    expect(args.where.timestamp).toBeUndefined();
  });
});
