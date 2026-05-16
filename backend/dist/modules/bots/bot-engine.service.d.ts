import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { InboxService } from '../inbox/inbox.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
export interface BotInboundMessage {
    id: number;
    companyId: number;
    conversationId: number;
    direction: 'inbound' | 'outbound';
    content: string;
}
interface ReplyTemplateAction {
    type: 'reply_template';
    templateId: number;
    variables?: Record<string, string>;
}
interface SendTextAction {
    type: 'send_text';
    message: string;
}
interface AssignAgentAction {
    type: 'assign_agent';
    userId: number;
}
interface ApplyTagAction {
    type: 'apply_tag';
    tag: string;
}
interface FireWebhookAction {
    type: 'fire_webhook';
    webhookEndpointId: number;
}
export type BotAction = ReplyTemplateAction | SendTextAction | AssignAgentAction | ApplyTagAction | FireWebhookAction;
export declare class BotEngineService {
    private readonly prisma;
    private readonly cache;
    private readonly jobQueue;
    private readonly inboxService;
    private readonly webhookDispatcher;
    private readonly logger;
    constructor(prisma: PrismaService, cache: CacheService, jobQueue: JobQueueService, inboxService: InboxService, webhookDispatcher: WebhookDispatcherService);
    static matchKeyword(triggerType: 'exact' | 'contains' | 'regex', keyword: string, text: string): boolean;
    runForMessage(msg: BotInboundMessage): Promise<void>;
    private executeAction;
    private loadActiveBots;
}
export {};
