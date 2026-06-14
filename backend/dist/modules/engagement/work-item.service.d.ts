import { WorkItem } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EventStoreService, ActorType } from '../../common/services/event-store.service';
import { WorkItemType } from './state/work-item-states';
export interface OpenWorkItemInput {
    companyId: number;
    conversationId: number;
    contactId: number;
    type: WorkItemType;
    owner?: 'AI' | 'HUMAN' | 'SYSTEM';
    externalRef?: string | null;
    priority?: number;
    actorType?: ActorType;
    actorId?: string | null;
    idempotencyKey?: string | null;
}
export interface TransitionInput {
    companyId: number;
    workItemId: number;
    event: string;
    actorType: ActorType;
    actorId?: string | null;
    payload?: unknown;
    idempotencyKey?: string | null;
    patch?: {
        externalRef?: string | null;
        assignedUserId?: number | null;
        owner?: 'AI' | 'HUMAN' | 'SYSTEM';
        expiresAt?: Date | null;
        priority?: number;
    };
}
export declare class InvalidTransitionError extends Error {
    readonly type: string;
    readonly from: string;
    readonly event: string;
    constructor(type: string, from: string, event: string);
}
export declare class WorkItemService {
    private readonly prisma;
    private readonly events;
    private readonly logger;
    constructor(prisma: PrismaService, events: EventStoreService);
    open(input: OpenWorkItemInput): Promise<WorkItem>;
    transition(input: TransitionInput): Promise<WorkItem>;
    handoff(companyId: number, workItemId: number, reason: string, slaMs?: number): Promise<void>;
    findOverdueHandoffs(limit?: number): Promise<WorkItem[]>;
    sweepOverdueHandoffs(slaMs: number, limit?: number): Promise<{
        swept: number;
        conversationIds: number[];
    }>;
    listOpen(companyId: number, conversationId: number): Promise<WorkItem[]>;
    get(companyId: number, id: number): Promise<WorkItem | null>;
}
