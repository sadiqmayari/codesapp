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
var AiAutoReplyService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiAutoReplyService = exports.AI_HANDOFF_LABEL = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const job_queue_service_1 = require("../../common/services/job-queue.service");
const platform_setting_service_1 = require("../../common/services/platform-setting.service");
const company_status_service_1 = require("../../common/services/company-status.service");
const ai_service_1 = require("../ai/ai.service");
const inbox_service_1 = require("../inbox/inbox.service");
const inbox_gateway_1 = require("../inbox/inbox.gateway");
const send_message_dto_1 = require("../inbox/dto/send-message.dto");
exports.AI_HANDOFF_LABEL = 'needs-human';
let AiAutoReplyService = AiAutoReplyService_1 = class AiAutoReplyService {
    constructor(prisma, jobQueue, ai, platformSetting, companyStatus, inboxService, gateway) {
        this.prisma = prisma;
        this.jobQueue = jobQueue;
        this.ai = ai;
        this.platformSetting = platformSetting;
        this.companyStatus = companyStatus;
        this.inboxService = inboxService;
        this.gateway = gateway;
        this.logger = new common_1.Logger(AiAutoReplyService_1.name);
    }
    onModuleInit() {
        this.jobQueue.registerWorker('ai', (p) => this.process(p), 2, 120);
    }
    async enqueue(job) {
        try {
            await this.jobQueue.enqueue('ai', job, {
                serialKey: `conv:ai:${job.conversationId}`,
            });
        }
        catch (e) {
            this.logger.warn(`AI auto-reply enqueue failed for convo ${job.conversationId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async process(job) {
        if (!(await this.companyStatus.isActive(job.companyId)))
            return;
        const convo = await this.prisma.conversation.findFirst({
            where: {
                id: job.conversationId,
                company_id: job.companyId,
                deleted_at: null,
            },
            select: {
                id: true,
                assigned_user_id: true,
                ai_autoreply: true,
                ai_order_created_at: true,
                company: {
                    select: {
                        ai_auto_order_enabled: true,
                        ai_auto_order_all_enabled: true,
                        ai_autoreply_enabled: true,
                    },
                },
            },
        });
        if (!convo)
            return;
        const allChats = convo.company?.ai_autoreply_enabled === true;
        const perChat = convo.ai_autoreply;
        if (perChat === false)
            return;
        const effectiveAuto = allChats || perChat === true;
        if (!effectiveAuto && !job.force)
            return;
        if (await this.platformSetting.isAiAgentEnabled(job.companyId)) {
            await this.jobQueue.enqueue('ai-agent', {
                companyId: job.companyId,
                conversationId: job.conversationId,
                messageId: job.messageId,
            });
            return;
        }
        const orderScopeA = perChat === true;
        const orderScopeB = convo.company?.ai_auto_order_all_enabled === true && effectiveAuto;
        if (convo.company?.ai_auto_order_enabled &&
            (orderScopeA || orderScopeB) &&
            !convo.ai_order_created_at &&
            !job.skipOrder) {
            try {
                await this.jobQueue.enqueue('ai-order', {
                    companyId: job.companyId,
                    conversationId: job.conversationId,
                    messageId: job.messageId,
                });
                return;
            }
            catch (e) {
                this.logger.warn(`ai-order enqueue failed (convo ${job.conversationId}) → normal reply: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        let decision;
        try {
            decision = await this.ai.autoReplyDecision(job.companyId, job.conversationId);
        }
        catch (e) {
            if (e instanceof common_1.ForbiddenException) {
                return;
            }
            throw e;
        }
        if (decision.skip)
            return;
        if (decision.handoff || !decision.reply) {
            await this.handoff(job.companyId, job.conversationId, decision.reason);
            return;
        }
        try {
            await this.inboxService.sendMessage(job.companyId, job.conversationId, {
                type: send_message_dto_1.SendMessageType.text,
                content: decision.reply,
            });
        }
        catch (e) {
            this.logger.debug(`AI auto-reply send failed (convo ${job.conversationId}) → handoff: ${e instanceof Error ? e.message : String(e)}`);
            await this.handoff(job.companyId, job.conversationId, 'send failed');
        }
    }
    async handoff(companyId, conversationId, reason) {
        try {
            await this.prisma.conversation.update({
                where: { id: conversationId },
                data: { status: 'pending', ai_autoreply: false },
            });
            await this.prisma.conversationLabel.upsert({
                where: {
                    conversation_id_label: {
                        conversation_id: conversationId,
                        label: exports.AI_HANDOFF_LABEL,
                    },
                },
                create: {
                    company_id: companyId,
                    conversation_id: conversationId,
                    label: exports.AI_HANDOFF_LABEL,
                },
                update: {},
            });
            this.gateway.emitToCompany(companyId, 'conversation.updated', {
                conversationId,
                addedLabel: exports.AI_HANDOFF_LABEL,
            });
            this.logger.log(`AI handoff for conversation ${conversationId}: ${reason}`);
        }
        catch (e) {
            this.logger.warn(`AI handoff flagging failed for convo ${conversationId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
};
exports.AiAutoReplyService = AiAutoReplyService;
exports.AiAutoReplyService = AiAutoReplyService = AiAutoReplyService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(5, (0, common_1.Inject)((0, common_1.forwardRef)(() => inbox_service_1.InboxService))),
    __param(6, (0, common_1.Inject)((0, common_1.forwardRef)(() => inbox_gateway_1.InboxGateway))),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        job_queue_service_1.JobQueueService,
        ai_service_1.AiService,
        platform_setting_service_1.PlatformSettingService,
        company_status_service_1.CompanyStatusService,
        inbox_service_1.InboxService,
        inbox_gateway_1.InboxGateway])
], AiAutoReplyService);
//# sourceMappingURL=ai-autoreply.service.js.map