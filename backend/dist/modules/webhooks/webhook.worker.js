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
var WebhookWorker_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookWorker = void 0;
const common_1 = require("@nestjs/common");
const uuid_1 = require("uuid");
const prisma_service_1 = require("../../prisma/prisma.service");
const job_queue_service_1 = require("../../common/services/job-queue.service");
const encryption_service_1 = require("../../common/services/encryption.service");
const webhook_delivery_service_1 = require("./webhook-delivery.service");
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
let WebhookWorker = WebhookWorker_1 = class WebhookWorker {
    constructor(prisma, jobQueue, encryption, delivery) {
        this.prisma = prisma;
        this.jobQueue = jobQueue;
        this.encryption = encryption;
        this.delivery = delivery;
        this.logger = new common_1.Logger(WebhookWorker_1.name);
    }
    onModuleInit() {
        this.jobQueue.registerWorker('webhook', (p) => this.handle(p), 3);
        this.logger.log('Registered webhook worker (concurrency=3)');
    }
    async handle(rawPayload) {
        const p = (rawPayload ?? {});
        const endpointId = p.webhookEndpointId;
        const event = p.event ?? 'unknown';
        const dataObj = (p.data ?? {});
        const companyId = p.companyId ?? dataObj.companyId ?? 0;
        if (!endpointId) {
            await this.delivery.writeLog({
                webhookId: 0,
                companyId,
                event,
                payload: p,
                deliveryStatus: 'failed',
                attempts: 1,
                reason: 'endpoint_inactive_or_missing',
            });
            return;
        }
        const endpoint = await this.prisma.webhookEndpoint.findUnique({
            where: { id: endpointId },
        });
        if (!endpoint || endpoint.status !== 'active') {
            await this.delivery.writeLog({
                webhookId: endpointId,
                companyId: endpoint?.company_id ?? companyId,
                event,
                payload: p,
                deliveryStatus: 'failed',
                attempts: 1,
                reason: 'endpoint_inactive_or_missing',
            });
            return;
        }
        const resolvedCompanyId = endpoint.company_id;
        const enqueuedMs = p.enqueuedAt ? Date.parse(p.enqueuedAt) : NaN;
        const isStale = Number.isNaN(enqueuedMs) || Date.now() - enqueuedMs > STALE_MS;
        if (isStale) {
            await this.delivery.writeLog({
                webhookId: endpointId,
                companyId: resolvedCompanyId,
                event,
                payload: p,
                deliveryStatus: 'failed',
                attempts: 1,
                reason: 'stale',
            });
            return;
        }
        let secret;
        try {
            secret = this.encryption.decrypt(endpoint.secret_key_encrypted);
        }
        catch {
            await this.delivery.writeLog({
                webhookId: endpointId,
                companyId: resolvedCompanyId,
                event,
                payload: p,
                deliveryStatus: 'failed',
                attempts: 1,
                reason: 'secret_decrypt_failed',
            });
            return;
        }
        const deliveryId = (0, uuid_1.v4)();
        const built = webhook_delivery_service_1.WebhookDeliveryService.buildPayload(event, resolvedCompanyId, p.data, deliveryId);
        const rawBody = JSON.stringify(built);
        const signature = webhook_delivery_service_1.WebhookDeliveryService.sign(rawBody, secret);
        await this.delivery.incrementWebhookCall(resolvedCompanyId);
        let status;
        try {
            const res = await this.delivery.post(endpoint.endpoint_url, {
                'content-type': 'application/json',
                'x-codesapp-signature': signature,
                'x-codesapp-event': event,
                'x-codesapp-delivery': deliveryId,
                'x-codesapp-timestamp': built.timestamp,
            }, rawBody);
            status = res.status;
        }
        catch (err) {
            await this.delivery.writeLog({
                webhookId: endpointId,
                companyId: resolvedCompanyId,
                event,
                payload: built,
                deliveryStatus: 'failed',
                attempts: 1,
                reason: 'network_error',
            });
            throw err instanceof Error ? err : new Error(String(err));
        }
        const outcome = webhook_delivery_service_1.WebhookDeliveryService.classify(status);
        if (outcome === 'success') {
            await this.delivery.writeLog({
                webhookId: endpointId,
                companyId: resolvedCompanyId,
                event,
                payload: built,
                deliveryStatus: 'success',
                httpStatus: status,
                attempts: 1,
            });
            return;
        }
        if (outcome === 'client_error') {
            await this.delivery.writeLog({
                webhookId: endpointId,
                companyId: resolvedCompanyId,
                event,
                payload: built,
                deliveryStatus: 'failed',
                httpStatus: status,
                attempts: 1,
                reason: 'client_error',
            });
            return;
        }
        await this.delivery.writeLog({
            webhookId: endpointId,
            companyId: resolvedCompanyId,
            event,
            payload: built,
            deliveryStatus: 'failed',
            httpStatus: status,
            attempts: 1,
            reason: 'server_error',
        });
        throw new Error(`Webhook ${endpointId} delivery failed with retryable status ${status}`);
    }
};
exports.WebhookWorker = WebhookWorker;
exports.WebhookWorker = WebhookWorker = WebhookWorker_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        job_queue_service_1.JobQueueService,
        encryption_service_1.EncryptionService,
        webhook_delivery_service_1.WebhookDeliveryService])
], WebhookWorker);
//# sourceMappingURL=webhook.worker.js.map