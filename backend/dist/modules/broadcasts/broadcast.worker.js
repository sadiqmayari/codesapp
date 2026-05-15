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
var BroadcastWorker_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.BroadcastWorker = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const job_queue_service_1 = require("../../common/services/job-queue.service");
const inbox_gateway_1 = require("../inbox/inbox.gateway");
const meta_client_service_1 = require("../inbox/meta-client.service");
const broadcasts_service_1 = require("./broadcasts.service");
let BroadcastWorker = BroadcastWorker_1 = class BroadcastWorker {
    constructor(prisma, jobQueue, broadcasts, metaClient, gateway) {
        this.prisma = prisma;
        this.jobQueue = jobQueue;
        this.broadcasts = broadcasts;
        this.metaClient = metaClient;
        this.gateway = gateway;
        this.logger = new common_1.Logger(BroadcastWorker_1.name);
    }
    onModuleInit() {
        this.jobQueue.registerWorker('broadcast', (p) => this.handle(p), 3);
        this.logger.log('Registered broadcast worker (concurrency=3)');
    }
    async handle(payload) {
        if (payload?.kind === 'dispatch') {
            await this.broadcasts.dispatch(payload.companyId, payload.broadcastId);
            return;
        }
        if (payload?.kind !== 'send')
            return;
        const broadcast = await this.prisma.broadcast.findUnique({
            where: { id: payload.broadcastId },
        });
        if (!broadcast || broadcast.status === 'cancelled')
            return;
        const [company, contact, template] = await Promise.all([
            this.prisma.company.findUnique({
                where: { id: payload.companyId },
                select: { phone_number_id: true },
            }),
            this.prisma.contact.findFirst({
                where: { id: payload.contactId, company_id: payload.companyId },
            }),
            this.prisma.template.findFirst({
                where: {
                    id: payload.templateId,
                    company_id: payload.companyId,
                    deleted_at: null,
                },
            }),
        ]);
        if (!company?.phone_number_id || !contact || !template?.meta_template_id) {
            await this.broadcasts.incrementCounters(payload.broadcastId, 'failed_count');
            return;
        }
        try {
            const langCode = template.content?.language ?? 'en_US';
            const components = this.buildComponents(payload.variables ?? {});
            const response = await this.metaClient.sendTemplate(payload.companyId, company.phone_number_id, contact.phone, template.name, langCode, components);
            const metaMessageId = response.messages?.[0]?.id ?? null;
            let convo = await this.prisma.conversation.findFirst({
                where: {
                    company_id: payload.companyId,
                    contact_id: contact.id,
                    deleted_at: null,
                },
                orderBy: { id: 'desc' },
            });
            if (!convo) {
                convo = await this.prisma.conversation.create({
                    data: {
                        company_id: payload.companyId,
                        contact_id: contact.id,
                        status: 'open',
                    },
                });
            }
            await this.prisma.message.create({
                data: {
                    conversation_id: convo.id,
                    company_id: payload.companyId,
                    broadcast_id: payload.broadcastId,
                    message_type: 'template',
                    direction: 'outbound',
                    content: `[template:${template.name}]`,
                    status: 'sent',
                    meta_message_id: metaMessageId,
                    timestamp: new Date(),
                },
            });
            const counters = await this.broadcasts.incrementCounters(payload.broadcastId, 'sent_count');
            const processed = counters.sent_count + counters.failed_count;
            if (broadcasts_service_1.BroadcastsService.shouldEmitProgress(processed)) {
                this.gateway.emitToCompany(payload.companyId, 'broadcast.progress', {
                    broadcastId: payload.broadcastId,
                    sent: counters.sent_count,
                    failed: counters.failed_count,
                    total: payload.total,
                });
            }
            const done = await this.broadcasts.markCompletedIfDone(payload.broadcastId, payload.total);
            if (done) {
                this.gateway.emitToCompany(payload.companyId, 'broadcast.progress', {
                    broadcastId: payload.broadcastId,
                    sent: counters.sent_count,
                    failed: counters.failed_count,
                    total: payload.total,
                    status: 'completed',
                });
            }
        }
        catch (err) {
            const counters = await this.broadcasts.incrementCounters(payload.broadcastId, 'failed_count');
            this.logger.warn(`Broadcast send failed for broadcast=${payload.broadcastId} contact=${payload.contactId}: ${err instanceof Error ? err.message : String(err)}`);
            await this.broadcasts.markCompletedIfDone(payload.broadcastId, payload.total);
            void counters;
            throw err;
        }
    }
    buildComponents(variables) {
        const entries = Object.entries(variables);
        if (entries.length === 0)
            return [];
        return [
            {
                type: 'body',
                parameters: entries
                    .sort(([a], [b]) => Number(a) - Number(b))
                    .map(([, value]) => ({ type: 'text', text: value })),
            },
        ];
    }
};
exports.BroadcastWorker = BroadcastWorker;
exports.BroadcastWorker = BroadcastWorker = BroadcastWorker_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        job_queue_service_1.JobQueueService,
        broadcasts_service_1.BroadcastsService,
        meta_client_service_1.MetaClientService,
        inbox_gateway_1.InboxGateway])
], BroadcastWorker);
//# sourceMappingURL=broadcast.worker.js.map