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
var OutboxSenderService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutboxSenderService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const job_queue_service_1 = require("../../common/services/job-queue.service");
const inbox_service_1 = require("./inbox.service");
const send_message_dto_1 = require("./dto/send-message.dto");
let OutboxSenderService = OutboxSenderService_1 = class OutboxSenderService {
    constructor(prisma, jobQueue, inbox) {
        this.prisma = prisma;
        this.jobQueue = jobQueue;
        this.inbox = inbox;
        this.logger = new common_1.Logger(OutboxSenderService_1.name);
    }
    onModuleInit() {
        this.jobQueue.registerWorker('outbox', (p) => this.process(p), 2, 60);
    }
    async process(job) {
        const row = await this.prisma.outbox.findFirst({
            where: { idempotency_key: job.idempotencyKey },
        });
        if (!row) {
            throw new Error(`outbox row not found yet for ${job.idempotencyKey}`);
        }
        if (row.state === 'SENT')
            return;
        if (row.kind === 'WHATSAPP_SEND') {
            const payload = row.payload;
            if (!payload?.conversationId || !payload.text) {
                await this.markFailed(row.id, 'malformed WHATSAPP_SEND payload');
                return;
            }
            const sent = (await this.inbox.sendMessage(row.company_id, payload.conversationId, {
                type: send_message_dto_1.SendMessageType.text,
                content: payload.text,
            }));
            await this.prisma.outbox.update({
                where: { id: row.id },
                data: {
                    state: 'SENT',
                    sent_at: new Date(),
                    provider_ref: sent?.id != null ? String(sent.id) : null,
                },
            });
            return;
        }
        await this.markFailed(row.id, `unhandled outbox kind: ${row.kind}`);
    }
    async markFailed(id, reason) {
        await this.prisma.outbox
            .update({
            where: { id },
            data: { state: 'FAILED', last_error: reason },
        })
            .catch(() => undefined);
        this.logger.warn(`outbox row ${String(id)} FAILED: ${reason}`);
    }
};
exports.OutboxSenderService = OutboxSenderService;
exports.OutboxSenderService = OutboxSenderService = OutboxSenderService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        job_queue_service_1.JobQueueService,
        inbox_service_1.InboxService])
], OutboxSenderService);
//# sourceMappingURL=outbox-sender.service.js.map