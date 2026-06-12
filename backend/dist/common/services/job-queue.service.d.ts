import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
type JobHandler = (payload: unknown) => Promise<void>;
export declare class JobQueueService implements OnModuleInit, OnModuleDestroy {
    private readonly prisma;
    private readonly logger;
    private readonly workers;
    private pollTimer;
    private stopped;
    constructor(prisma: PrismaService);
    onModuleInit(): void;
    onModuleDestroy(): void;
    private scheduleNextPoll;
    enqueue(queueName: string, payload: unknown, opts?: {
        delayMs?: number;
        maxAttempts?: number;
    }): Promise<number>;
    registerWorker(queueName: string, handler: JobHandler, concurrency?: number): void;
    private poll;
    private runJob;
}
export {};
