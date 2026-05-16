import { WebhooksService } from './webhooks.service';
import { CreateEndpointDto } from './dtos/create-endpoint.dto';
import { UpdateEndpointDto } from './dtos/update-endpoint.dto';
import { ListLogsDto } from './dtos/list-logs.dto';
export declare class WebhooksController {
    private readonly webhooks;
    constructor(webhooks: WebhooksService);
    listEndpoints(user: {
        companyId: number;
    }, page?: number, limit?: number): Promise<{
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
    listLogs(user: {
        companyId: number;
    }, dto: ListLogsDto): Promise<{
        success: boolean;
        data: {
            payload: import("@prisma/client/runtime/library").JsonValue;
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
    getEndpoint(user: {
        companyId: number;
    }, id: number): Promise<{
        id: number;
        company_id: number;
        endpoint_url: string;
        events: unknown;
        status: string;
        secret: string;
        created_at: Date;
    }>;
    create(user: {
        companyId: number;
    }, dto: CreateEndpointDto): Promise<{
        id: number;
        company_id: number;
        endpoint_url: string;
        events: unknown;
        status: string;
        secret: string;
        created_at: Date;
    }>;
    update(user: {
        companyId: number;
    }, id: number, dto: UpdateEndpointDto): Promise<{
        id: number;
        company_id: number;
        endpoint_url: string;
        events: unknown;
        status: string;
        secret: string;
        created_at: Date;
    }>;
    remove(user: {
        companyId: number;
    }, id: number): Promise<{
        ok: boolean;
    }>;
    toggle(user: {
        companyId: number;
    }, id: number): Promise<{
        id: number;
        company_id: number;
        endpoint_url: string;
        events: unknown;
        status: string;
        secret: string;
        created_at: Date;
    }>;
    test(user: {
        companyId: number;
    }, id: number): Promise<{
        enqueued: boolean;
        jobId: number;
    }>;
    retry(user: {
        companyId: number;
    }, id: number): Promise<{
        reEnqueued: boolean;
        jobId: number;
    }>;
}
