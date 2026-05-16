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
var WebhookDeliveryService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookDeliveryService = void 0;
const common_1 = require("@nestjs/common");
const https = require("https");
const crypto = require("crypto");
const prisma_service_1 = require("../../prisma/prisma.service");
const REQUEST_TIMEOUT_MS = 10_000;
let WebhookDeliveryService = WebhookDeliveryService_1 = class WebhookDeliveryService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(WebhookDeliveryService_1.name);
    }
    static sign(rawJsonBody, secret) {
        const hex = crypto
            .createHmac('sha256', secret)
            .update(rawJsonBody, 'utf8')
            .digest('hex');
        return `sha256=${hex}`;
    }
    static classify(status) {
        if (status >= 200 && status < 300)
            return 'success';
        if (status === 408 || status === 429)
            return 'retry';
        if (status >= 300 && status < 500)
            return 'client_error';
        return 'retry';
    }
    static buildPayload(event, companyId, data, deliveryId) {
        return {
            event,
            delivery_id: deliveryId,
            timestamp: new Date().toISOString(),
            company_id: companyId,
            data,
        };
    }
    post(endpointUrl, headers, body) {
        return new Promise((resolve, reject) => {
            let u;
            try {
                u = new URL(endpointUrl);
            }
            catch {
                reject(new Error(`Invalid webhook URL: ${endpointUrl}`));
                return;
            }
            const req = https.request({
                host: u.host,
                path: `${u.pathname}${u.search}`,
                method: 'POST',
                headers: {
                    ...headers,
                    'content-length': Buffer.byteLength(body).toString(),
                },
                timeout: REQUEST_TIMEOUT_MS,
                agent: false,
            }, (res) => {
                res.on('data', () => undefined);
                res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
            });
            req.on('timeout', () => req.destroy(new Error('Webhook delivery timed out')));
            req.on('error', (err) => reject(err));
            req.write(body);
            req.end();
        });
    }
    async incrementWebhookCall(companyId) {
        const period = new Date().toISOString().slice(0, 7);
        await this.prisma.$executeRawUnsafe(`INSERT INTO usage_metering (company_id, period, webhook_calls, updated_at)
       VALUES (?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE webhook_calls = webhook_calls + 1, updated_at = NOW()`, companyId, period);
    }
    async writeLog(params) {
        await this.prisma.webhookLog.create({
            data: {
                webhook_id: params.webhookId,
                company_id: params.companyId,
                event_name: params.event,
                payload: {
                    payload: params.payload,
                    reason: params.reason ?? null,
                },
                delivery_status: params.deliveryStatus,
                http_status: params.httpStatus ?? null,
                attempts: params.attempts,
            },
        });
    }
};
exports.WebhookDeliveryService = WebhookDeliveryService;
exports.WebhookDeliveryService = WebhookDeliveryService = WebhookDeliveryService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], WebhookDeliveryService);
//# sourceMappingURL=webhook-delivery.service.js.map