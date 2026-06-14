import { PrismaService } from '../../prisma/prisma.service';
export declare class EngagementMetricsService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    snapshot(): Promise<{
        timestamp: string;
        queues: Record<string, Record<string, number>>;
        oldestPendingJob: {
            queue: string;
            ageSec: number;
        } | null;
        deadLetter: {
            count: number;
            recent: {
                queue_name: string;
                attempts: number;
                run_at: Date;
                last_error: string | null;
                id: number;
            }[];
        };
        outbox: {
            [k: string]: number;
        };
        workItems: {
            type: string;
            status: string;
            count: number;
        }[];
        overdueHandoffs: number;
        eventsLast24h: number;
    }>;
}
