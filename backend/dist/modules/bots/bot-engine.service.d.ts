import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { CompanyStatusService } from '../../common/services/company-status.service';
import { JobQueueService } from '../../common/services/job-queue.service';
import { InboxService } from '../inbox/inbox.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { AiAutoReplyService } from './ai-autoreply.service';
export interface BotInboundMessage {
    id: number;
    companyId: number;
    conversationId: number;
    direction: 'inbound' | 'outbound';
    content: string;
    messageType?: string;
    isOrderDecision?: boolean;
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
interface AiReplyAction {
    type: 'ai_reply';
}
export type BotAction = ReplyTemplateAction | SendTextAction | AssignAgentAction | ApplyTagAction | FireWebhookAction | AiReplyAction;
export declare class BotEngineService {
    private readonly prisma;
    private readonly cache;
    private readonly companyStatus;
    private readonly jobQueue;
    private readonly inboxService;
    private readonly webhookDispatcher;
    private readonly aiAutoReply;
    private readonly logger;
    constructor(prisma: PrismaService, cache: CacheService, companyStatus: CompanyStatusService, jobQueue: JobQueueService, inboxService: InboxService, webhookDispatcher: WebhookDispatcherService, aiAutoReply: AiAutoReplyService);
    static matchKeyword(triggerType: 'exact' | 'contains' | 'regex', keyword: string, text: string): boolean;
    runForMessage(msg: BotInboundMessage): Promise<void>;
    private executeAction;
    private loadActiveBots;
}
export {};
