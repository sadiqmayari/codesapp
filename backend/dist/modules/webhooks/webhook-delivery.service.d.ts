import { PrismaService } from '../../prisma/prisma.service';
export type DeliveryOutcome = 'success' | 'client_error' | 'retry';
export interface BuiltWebhookPayload {
    event: string;
    delivery_id: string;
    timestamp: string;
    company_id: number;
    data: unknown;
}
export interface HttpResult {
    status: number;
}
export declare class WebhookDeliveryService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    static sign(rawJsonBody: string, secret: string): string;
    static classify(status: number): DeliveryOutcome;
    static buildPayload(event: string, companyId: number, data: unknown, deliveryId: string): BuiltWebhookPayload;
    post(endpointUrl: string, headers: Record<string, string>, body: string): Promise<HttpResult>;
    incrementWebhookCall(companyId: number): Promise<void>;
    writeLog(params: {
        webhookId: number;
        companyId: number;
        event: string;
        payload: unknown;
        deliveryStatus: 'success' | 'failed' | 'pending';
        httpStatus?: number | null;
        attempts: number;
        reason?: string;
    }): Promise<void>;
}
