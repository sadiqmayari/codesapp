import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from './job-queue.service';
export type OutboxKind = 'WHATSAPP_SEND' | 'SHOPIFY_CALL';
export interface OutboxJob {
    idempotencyKey: string;
}
export interface OutboxInput {
    companyId: number;
    kind: OutboxKind;
    idempotencyKey: string;
    payload: unknown;
}
export declare class OutboxService {
    private readonly prisma;
    private readonly jobQueue;
    private readonly logger;
    constructor(prisma: PrismaService, jobQueue: JobQueueService);
    enqueue(input: OutboxInput, tx?: Prisma.TransactionClient): Promise<void>;
}
