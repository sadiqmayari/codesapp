import { ConfigService } from '@nestjs/config';
import { InboxService } from './inbox.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { InboxGateway } from './inbox.gateway';
import { MetaClientService } from './meta-client.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';

function build(
  convoOverrides: Record<string, unknown> = {},
  pinOverrides: { existing?: unknown; count?: number } = {},
) {
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
  const conversationPin = {
    findUnique: jest.fn().mockResolvedValue(pinOverrides.existing ?? null),
    count: jest.fn().mockResolvedValue(pinOverrides.count ?? 0),
    create: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    findMany: jest.fn().mockResolvedValue([]),
  };
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
    conversationPin,
    message: {
      findMany: jest.fn().mockImplementation((args: Record<string, unknown>) => {
        lastFindManyArgs = args;
        return Promise.resolve([]);
      }),
    },
  } as unknown as PrismaService;

  const gateway = {
    emitToCompany: jest.fn(),
    emitToUsers: jest.fn(),
    emitToPrivileged: jest.fn(),
  } as unknown as InboxGateway;
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
    conversationPin,
    getFindManyArgs: () => lastFindManyArgs,
  };
}

describe('InboxService.setPinned (per-user)', () => {
  it('pins by creating a ConversationPin and emits to the user room only', async () => {
    const { service, conversationPin, gateway } = build();
    await service.setPinned(1, 10, 7, true);
    expect(conversationPin.create).toHaveBeenCalledWith({
      data: { company_id: 1, conversation_id: 10, user_id: 7 },
    });
    expect(gateway.emitToUsers).toHaveBeenCalledWith([7], 'conversation.updated', {
      conversationId: 10,
    });
    expect(gateway.emitToPrivileged).toHaveBeenCalledWith(1, 'pins.updated', {});
  });

  it('rejects a 4th pin (cap = 3)', async () => {
    const { service, conversationPin } = build({}, { count: 3 });
    await expect(service.setPinned(1, 10, 7, true)).rejects.toThrow(/up to 3/);
    expect(conversationPin.create).not.toHaveBeenCalled();
  });

  it('re-pinning an already-pinned chat is a no-op (does not count against the cap)', async () => {
    const { service, conversationPin } = build({}, { existing: { id: 99 }, count: 3 });
    await service.setPinned(1, 10, 7, true);
    expect(conversationPin.create).not.toHaveBeenCalled();
  });

  it('unpins by deleting the user’s ConversationPin', async () => {
    const { service, conversationPin } = build();
    await service.setPinned(1, 10, 7, false);
    expect(conversationPin.deleteMany).toHaveBeenCalledWith({
      where: { company_id: 1, user_id: 7, conversation_id: 10 },
    });
  });
});

describe('InboxService.adminUnpin', () => {
  it("removes a target user's pin and signals both rooms", async () => {
    const { service, conversationPin, gateway } = build();
    await service.adminUnpin(1, 7, 10);
    expect(conversationPin.deleteMany).toHaveBeenCalledWith({
      where: { company_id: 1, user_id: 7, conversation_id: 10 },
    });
    expect(gateway.emitToUsers).toHaveBeenCalledWith([7], 'conversation.updated', {
      conversationId: 10,
    });
    expect(gateway.emitToPrivileged).toHaveBeenCalledWith(1, 'pins.updated', {});
  });
});

describe('InboxService.clearHistory', () => {
  it('sets cleared_before to a Date and emits conversation.updated', async () => {
    const { service, updates, gateway } = build();
    await service.clearHistory(1, 10);
    expect(updates[0].cleared_before).toBeInstanceOf(Date);
    expect(gateway.emitToCompany).toHaveBeenCalledWith(1, 'conversation.updated', {
      conversationId: 10,
    });
  });
});

describe('InboxService.listConversations ordering', () => {
  it('orders the (non-pinned) list by recency', async () => {
    const { service, getFindManyArgs } = build();
    await service.listConversations(1, {} as never, { userId: 1, role: 'owner' });
    const args = getFindManyArgs() as { orderBy: Array<Record<string, string>> };
    expect(args.orderBy[0]).toEqual({ last_message_at: 'desc' });
  });
});

describe('InboxService.listMessages clear marker', () => {
  it('filters out messages at/before cleared_before', async () => {
    const cleared = new Date('2026-05-01T00:00:00.000Z');
    const { service, getFindManyArgs } = build({ cleared_before: cleared });
    await service.listMessages(1, 10, undefined, 50);
    const args = getFindManyArgs() as { where: { timestamp?: { gt: Date } } };
    expect(args.where.timestamp).toEqual({ gt: cleared });
  });

  it('does not filter when cleared_before is null', async () => {
    const { service, getFindManyArgs } = build({ cleared_before: null });
    await service.listMessages(1, 10, undefined, 50);
    const args = getFindManyArgs() as { where: Record<string, unknown> };
    expect(args.where.timestamp).toBeUndefined();
  });
});
