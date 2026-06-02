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
const ai_service_1 = require("../ai/ai.service");
const inbox_service_1 = require("../inbox/inbox.service");
const send_message_dto_1 = require("../inbox/dto/send-message.dto");
exports.AI_HANDOFF_LABEL = 'needs-human';
let AiAutoReplyService = AiAutoReplyService_1 = class AiAutoReplyService {
    constructor(prisma, jobQueue, ai, inboxService) {
        this.prisma = prisma;
        this.jobQueue = jobQueue;
        this.ai = ai;
        this.inboxService = inboxService;
        this.logger = new common_1.Logger(AiAutoReplyService_1.name);
    }
    onModuleInit() {
        this.jobQueue.registerWorker('ai', (p) => this.process(p), 2);
    }
    async enqueue(job) {
        try {
            await this.jobQueue.enqueue('ai', job);
        }
        catch (e) {
            this.logger.warn(`AI auto-reply enqueue failed for convo ${job.conversationId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async process(job) {
        const convo = await this.prisma.conversation.findFirst({
            where: {
                id: job.conversationId,
                company_id: job.companyId,
                deleted_at: null,
            },
            select: { id: true, assigned_user_id: true },
        });
        if (!convo)
            return;
        if (convo.assigned_user_id && !job.force)
            return;
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
    __param(3, (0, common_1.Inject)((0, common_1.forwardRef)(() => inbox_service_1.InboxService))),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        job_queue_service_1.JobQueueService,
        ai_service_1.AiService,
        inbox_service_1.InboxService])
], AiAutoReplyService);
//# sourceMappingURL=ai-autoreply.service.js.map