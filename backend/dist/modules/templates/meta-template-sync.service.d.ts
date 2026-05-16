import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MetaClientService } from '../inbox/meta-client.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
export declare class MetaTemplateSyncService {
    private readonly config;
    private readonly prisma;
    private readonly metaClient;
    private readonly webhookDispatcher;
    private readonly logger;
    private readonly graphVersion;
    constructor(config: ConfigService, prisma: PrismaService, metaClient: MetaClientService, webhookDispatcher: WebhookDispatcherService);
    syncFromMeta(companyId: number): Promise<{
        synced: number;
        deleted: number;
    }>;
    submitToMeta(companyId: number, wabaId: string, payload: {
        name: string;
        category: string;
        language: string;
        components: unknown[];
    }): Promise<{
        id: string | null;
        error?: string;
    }>;
    private fetchAllTemplates;
    private normalizeStatus;
    private normalizeCategory;
    private getJson;
    private postJson;
    private request;
}
