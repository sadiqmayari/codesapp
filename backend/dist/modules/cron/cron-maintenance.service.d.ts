import { PrismaService } from '../../prisma/prisma.service';
export declare class CronMaintenanceService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    cleanupMedia(): Promise<{
        processed: number;
        deleted: number;
        ioErrors: number;
        durationMs: number;
    }>;
    cleanupOrphans(): Promise<{
        released: number;
    }>;
    purgeOldJobs(): Promise<{
        purged: number;
    }>;
}
