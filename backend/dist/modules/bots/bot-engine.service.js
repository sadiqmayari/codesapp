"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var BotEngineService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.BotEngineService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const cache_service_1 = require("../../common/services/cache.service");
const job_queue_service_1 = require("../../common/services/job-queue.service");
const inbox_service_1 = require("../inbox/inbox.service");
const send_message_dto_1 = require("../inbox/dto/send-message.dto");
const webhook_dispatcher_service_1 = require("../webhooks/webhook-dispatcher.service");
const BOTS_CACHE_TTL_SEC = 60;
let BotEngineService = BotEngineService_1 = class BotEngineService {
    constructor(prisma, cache, jobQueue, inboxService, webhookDispatcher) {
        this.prisma = prisma;
        this.cache = cache;
        this.jobQueue = jobQueue;
        this.inboxService = inboxService;
        this.webhookDispatcher = webhookDispatcher;
        this.logger = new common_1.Logger(BotEngineService_1.name);
    }
    static matchKeyword(triggerType, keyword, text) {
        const lower = text.trim().toLowerCase();
        switch (triggerType) {
            case 'exact':
                return lower === keyword.trim().toLowerCase();
            case 'contains':
                return lower.includes(keyword.toLowerCase());
            case 'regex': {
                try {
                    return new RegExp(keyword, 'i').test(text);
                }
                catch {
                    return false;
                }
            }
        }
    }
    async runForMessage(msg) {
        if (msg.direction !== 'inbound')
            return;
        if (!msg.content)
            return;
        const bots = await this.loadActiveBots(msg.companyId);
        if (bots.length === 0)
            return;
        const convo = await this.prisma.conversation.findUnique({
            where: { id: msg.conversationId },
            select: { id: true, contact_id: true, assigned_user_id: true },
        });
        if (!convo)
            return;
        for (const bot of bots) {
            const matched = BotEngineService_1.matchKeyword(bot.trigger_type, bot.keyword, msg.content);
            if (!matched)
                continue;
            const actionsRun = [];
            for (const action of bot.actions ?? []) {
                try {
                    if (action.type === 'assign_agent' && convo.assigned_user_id) {
                        continue;
                    }
                    await this.executeAction(action, msg, convo.contact_id, bot.id);
                    actionsRun.push(action.type);
                }
                catch (err) {
                    this.logger.warn(`Bot ${bot.id} action ${action.type} failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (actionsRun.length > 0) {
                await this.prisma.auditLog.create({
                    data: {
                        company_id: msg.companyId,
                        user_id: 0,
                        action: 'bot.executed',
                        entity: 'bots',
                        entity_id: bot.id,
                        metadata: {
                            messageId: msg.id,
                            conversationId: msg.conversationId,
                            actionsRun,
                        },
                    },
                }).catch((err) => {
                    this.logger.debug(`bot.executed audit failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
                });
            }
        }
    }
    async executeAction(action, msg, contactId, botId) {
        switch (action.type) {
            case 'reply_template': {
                await this.inboxService.sendMessage(msg.companyId, msg.conversationId, {
                    type: send_message_dto_1.SendMessageType.template,
                    templateId: action.templateId,
                    variables: action.variables,
                });
                return;
            }
            case 'send_text': {
                await this.inboxService.sendMessage(msg.companyId, msg.conversationId, {
                    type: send_message_dto_1.SendMessageType.text,
                    content: action.message,
                });
                return;
            }
            case 'assign_agent': {
                await this.prisma.conversation.update({
                    where: { id: msg.conversationId },
                    data: { assigned_user_id: action.userId },
                });
                return;
            }
            case 'apply_tag': {
                const contact = await this.prisma.contact.findUnique({
                    where: { id: contactId },
                    select: { tags: true },
                });
                const existing = Array.isArray(contact?.tags) ? contact.tags : [];
                if (!existing.includes(action.tag)) {
                    await this.prisma.contact.update({
                        where: { id: contactId },
                        data: { tags: [...existing, action.tag] },
                    });
                }
                return;
            }
            case 'fire_webhook': {
                await this.webhookDispatcher.dispatch(msg.companyId, 'keyword.triggered', {
                    conversationId: msg.conversationId,
                    messageId: msg.id,
                    contactId,
                    botId,
                    webhookEndpointId: action.webhookEndpointId,
                });
                return;
            }
        }
    }
    async loadActiveBots(companyId) {
        const key = `bots:active:${companyId}`;
        const cached = this.cache.get(key);
        if (cached)
            return cached;
        const rows = await this.prisma.bot.findMany({
            where: { company_id: companyId, status: 'active' },
            select: {
                id: true,
                trigger_type: true,
                keyword: true,
                actions: true,
            },
        });
        const bots = rows.map((r) => ({
            id: r.id,
            trigger_type: r.trigger_type,
            keyword: r.keyword,
            actions: (r.actions ?? []),
        }));
        this.cache.set(key, bots, BOTS_CACHE_TTL_SEC);
        return bots;
    }
};
exports.BotEngineService = BotEngineService;
exports.BotEngineService = BotEngineService = BotEngineService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(3, (0, common_1.Inject)((0, common_1.forwardRef)(() => inbox_service_1.InboxService))),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        cache_service_1.CacheService,
        job_queue_service_1.JobQueueService,
        inbox_service_1.InboxService,
        webhook_dispatcher_service_1.WebhookDispatcherService])
], BotEngineService);
//# sourceMappingURL=bot-engine.service.js.map