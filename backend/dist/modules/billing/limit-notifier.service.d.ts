import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { MailService } from '../../common/services/mail.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { InboxGateway } from '../inbox/inbox.gateway';
export declare class LimitNotifierService {
    private readonly prisma;
    private readonly cache;
    private readonly mail;
    private readonly dispatcher;
    private readonly gateway;
    private readonly logger;
    constructor(prisma: PrismaService, cache: CacheService, mail: MailService, dispatcher: WebhookDispatcherService, gateway: InboxGateway);
    evaluate(companyId: number, rawDim: string): Promise<void>;
    private markFlag;
    private fireOne;
    snapshot(companyId: number): Promise<Array<{
        dim: 'contacts' | 'templates';
        threshold: '90' | '99' | '100';
        pct: number;
        current: number;
        limit: number;
        severity: 'warn' | 'critical';
    }>>;
    sendSuspensionEmail(companyId: number): Promise<void>;
}
