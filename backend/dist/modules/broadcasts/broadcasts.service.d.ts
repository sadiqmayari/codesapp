import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { MetaClientService } from '../inbox/meta-client.service';
import { SegmentsService } from '../contacts/segments.service';
import { CreateBroadcastDto } from './dto/create-broadcast.dto';
import { ScheduleBroadcastDto } from './dto/schedule-broadcast.dto';
import { ListBroadcastsDto } from './dto/list-broadcasts.dto';
import { PreviewAudienceDto } from './dto/preview-audience.dto';
import { TestSendDto } from './dto/test-send.dto';
export interface PersonalizationContact {
    name: string | null;
    phone: string | null;
    email: string | null;
    custom_fields: unknown;
}
export declare class BroadcastsService {
    private readonly prisma;
    private readonly jobQueue;
    private readonly segmentsService;
    private readonly metaClient;
    private readonly logger;
    constructor(prisma: PrismaService, jobQueue: JobQueueService, segmentsService: SegmentsService, metaClient: MetaClientService);
    list(companyId: number, dto: ListBroadcastsDto): Prisma.PrismaPromise<{
        status: import(".prisma/client").$Enums.BroadcastStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        template_id: number;
        audience_filter: Prisma.JsonValue;
        scheduled_at: Date | null;
        sent_count: number;
        delivered_count: number;
        read_count: number;
        failed_count: number;
    }[]>;
    get(companyId: number, id: number): Promise<{
        status: import(".prisma/client").$Enums.BroadcastStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        template_id: number;
        audience_filter: Prisma.JsonValue;
        scheduled_at: Date | null;
        sent_count: number;
        delivered_count: number;
        read_count: number;
        failed_count: number;
    }>;
    create(companyId: number, dto: CreateBroadcastDto): Promise<{
        status: import(".prisma/client").$Enums.BroadcastStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        template_id: number;
        audience_filter: Prisma.JsonValue;
        scheduled_at: Date | null;
        sent_count: number;
        delivered_count: number;
        read_count: number;
        failed_count: number;
    }>;
    update(companyId: number, id: number, dto: CreateBroadcastDto): Promise<{
        status: import(".prisma/client").$Enums.BroadcastStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
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
    previewAudience(companyId: number, dto: PreviewAudienceDto): Promise<{
        count: number;
        sample: {
            id: number;
            name: string;
            phone: string;
        }[];
    }>;
    testSend(companyId: number, dto: TestSendDto): Promise<{
        ok: boolean;
    }>;
    duplicate(companyId: number, id: number): Promise<{
        status: import(".prisma/client").$Enums.BroadcastStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        template_id: number;
        audience_filter: Prisma.JsonValue;
        scheduled_at: Date | null;
        sent_count: number;
        delivered_count: number;
        read_count: number;
        failed_count: number;
    }>;
    static resolveVariableValue(raw: string, contact: PersonalizationContact): string;
    static buildTemplateComponents(variables: Record<string, string>, contact: PersonalizationContact): unknown[];
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
