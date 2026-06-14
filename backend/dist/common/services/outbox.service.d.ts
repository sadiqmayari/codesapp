import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
export type OutboxKind = 'WHATSAPP_SEND' | 'SHOPIFY_CALL';
export interface OutboxInput {
    companyId: number;
    kind: OutboxKind;
    idempotencyKey: string;
    payload: unknown;
}
export declare class OutboxService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    enqueue(input: OutboxInput, tx?: Prisma.TransactionClient): Promise<void>;
}
