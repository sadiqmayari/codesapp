import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { CreateEndpointDto } from './dtos/create-endpoint.dto';
import { UpdateEndpointDto } from './dtos/update-endpoint.dto';
import { ListLogsDto } from './dtos/list-logs.dto';
export declare class WebhooksService {
    private readonly prisma;
    private readonly encryption;
    private readonly jobQueue;
    private readonly dispatcher;
    constructor(prisma: PrismaService, encryption: EncryptionService, jobQueue: JobQueueService, dispatcher: WebhookDispatcherService);
    private sanitize;
    listEndpoints(companyId: number, page?: number, limit?: number): Promise<{
        success: boolean;
        data: {
            id: number;
            company_id: number;
            endpoint_url: string;
            events: unknown;
            status: string;
            secret: string;
            created_at: Date;
        }[];
        message: string;
        meta: {
            page: number;
            limit: number;
            total: number;
        };
    }>;
    getEndpoint(companyId: number, id: number): Promise<{
        id: number;
        company_id: number;
        endpoint_url: string;
        events: unknown;
        status: string;
        secret: string;
        created_at: Date;
    }>;
    createEndpoint(companyId: number, dto: CreateEndpointDto): Promise<{
        id: number;
        company_id: number;
        endpoint_url: string;
        events: unknown;
        status: string;
        secret: string;
        created_at: Date;
    }>;
    updateEndpoint(companyId: number, id: number, dto: UpdateEndpointDto): Promise<{
        id: number;
        company_id: number;
        endpoint_url: string;
        events: unknown;
        status: string;
        secret: string;
        created_at: Date;
    }>;
    deleteEndpoint(companyId: number, id: number): Promise<{
        ok: boolean;
    }>;
    toggleEndpoint(companyId: number, id: number): Promise<{
        id: number;
        company_id: number;
        endpoint_url: string;
        events: unknown;
        status: string;
        secret: string;
        created_at: Date;
    }>;
    testEndpoint(companyId: number, id: number): Promise<{
        enqueued: boolean;
        jobId: number;
    }>;
    listLogs(companyId: number, dto: ListLogsDto): Promise<{
        success: boolean;
        data: {
            payload: Prisma.JsonValue;
            attempts: number;
            created_at: Date;
            id: number;
            company_id: number;
            webhook_id: number;
            event_name: string;
            delivery_status: import(".prisma/client").$Enums.WebhookDeliveryStatus;
            http_status: number | null;
            next_retry_at: Date | null;
        }[];
        message: string;
        meta: {
            page: number;
            limit: number;
            total: number;
        };
    }>;
    retryLog(companyId: number, logId: number): Promise<{
        reEnqueued: boolean;
        jobId: number;
    }>;
    private requireEndpoint;
}
