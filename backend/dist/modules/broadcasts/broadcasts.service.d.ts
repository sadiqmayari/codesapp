import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { SegmentsService } from '../contacts/segments.service';
import { CreateBroadcastDto } from './dto/create-broadcast.dto';
import { ScheduleBroadcastDto } from './dto/schedule-broadcast.dto';
import { ListBroadcastsDto } from './dto/list-broadcasts.dto';
export declare class BroadcastsService {
    private readonly prisma;
    private readonly jobQueue;
    private readonly segmentsService;
    private readonly logger;
    constructor(prisma: PrismaService, jobQueue: JobQueueService, segmentsService: SegmentsService);
    list(companyId: number, dto: ListBroadcastsDto): Prisma.PrismaPromise<{
        id: number;
        company_id: number;
        name: string;
        status: import(".prisma/client").$Enums.BroadcastStatus;
        created_at: Date;
        template_id: number;
        audience_filter: Prisma.JsonValue;
        scheduled_at: Date | null;
        sent_count: number;
        delivered_count: number;
        read_count: number;
        failed_count: number;
    }[]>;
    get(companyId: number, id: number): Promise<{
        id: number;
        company_id: number;
        name: string;
        status: import(".prisma/client").$Enums.BroadcastStatus;
        created_at: Date;
        template_id: number;
        audience_filter: Prisma.JsonValue;
        scheduled_at: Date | null;
        sent_count: number;
        delivered_count: number;
        read_count: number;
        failed_count: number;
    }>;
    create(companyId: number, dto: CreateBroadcastDto): Promise<{
        id: number;
        company_id: number;
        name: string;
        status: import(".prisma/client").$Enums.BroadcastStatus;
        created_at: Date;
        template_id: number;
        audience_filter: Prisma.JsonValue;
        scheduled_at: Date | null;
        sent_count: number;
        delivered_count: number;
        read_count: number;
        failed_count: number;
    }>;
    update(companyId: number, id: number, dto: CreateBroadcastDto): Promise<{
        id: number;
        company_id: number;
        name: string;
        status: import(".prisma/client").$Enums.BroadcastStatus;
        created_at: Date;
        template_id: number;
        audience_filter: Prisma.JsonValue;
        scheduled_at: Date | null;
        sent_count: number;
        delivered_count: number;
        read_count: number;
        failed_count: number;
    }>;
    sendNow(companyId: number, id: number): Promise<{
        ok: boolean;
    }>;
    schedule(companyId: number, id: number, dto: ScheduleBroadcastDto): Promise<{
        ok: boolean;
        runAt: Date;
    }>;
    cancel(companyId: number, id: number): Promise<{
        ok: boolean;
    }>;
    analytics(companyId: number, id: number): Promise<{
        id: number;
        name: string;
        status: import(".prisma/client").$Enums.BroadcastStatus;
        total: number;
        sent: number;
        delivered: number;
        read: number;
        failed: number;
        scheduledAt: Date | null;
        createdAt: Date;
    }>;
    dispatch(companyId: number, broadcastId: number): Promise<void>;
    private resolveAudience;
    private resolveAudienceSize;
    incrementCounters(broadcastId: number, field: 'sent_count' | 'failed_count'): Promise<{
        sent_count: number;
        failed_count: number;
        total: number | null;
    }>;
    markCompletedIfDone(broadcastId: number, total: number): Promise<boolean>;
    static shouldEmitProgress(processed: number): boolean;
}
