import { PrismaService } from '../../prisma/prisma.service';
export type AggregateType = 'CONVERSATION' | 'WORK_ITEM' | 'ORDER' | 'TICKET';
export type ActorType = 'CUSTOMER' | 'AI' | 'AGENT' | 'SYSTEM' | 'SHOPIFY' | 'META';
export interface EventInput {
    companyId: number;
    aggregateType: AggregateType;
    aggregateId: number | bigint;
    type: string;
    actorType: ActorType;
    actorId?: string | null;
    payload?: unknown;
    idempotencyKey?: string | null;
}
export declare class EventStoreService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    append(e: EventInput): Promise<void>;
}
