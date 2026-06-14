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
var MetaWebhookController_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MetaWebhookController = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto = require("crypto");
const job_queue_service_1 = require("../../common/services/job-queue.service");
const encryption_service_1 = require("../../common/services/encryption.service");
const prisma_service_1 = require("../../prisma/prisma.service");
let MetaWebhookController = MetaWebhookController_1 = class MetaWebhookController {
    constructor(config, jobQueue, prisma, encryption) {
        this.config = config;
        this.jobQueue = jobQueue;
        this.prisma = prisma;
        this.encryption = encryption;
        this.logger = new common_1.Logger(MetaWebhookController_1.name);
    }
    async resolveSecrets(key) {
        const envVerify = this.config.get('META_VERIFY_TOKEN');
        const envSecret = this.config.get('META_APP_SECRET');
        if (!key)
            return { verifyToken: envVerify, appSecret: envSecret };
        const company = await this.prisma.company.findFirst({
            where: { webhook_key: key },
            select: {
                webhook_verify_token: true,
                webhook_app_secret_encrypted: true,
            },
        });
        if (!company)
            return {};
        let appSecret = envSecret;
        if (company.webhook_app_secret_encrypted) {
            try {
                appSecret = this.encryption.decrypt(company.webhook_app_secret_encrypted);
            }
            catch {
                appSecret = undefined;
            }
        }
        return {
            verifyToken: company.webhook_verify_token || envVerify,
            appSecret,
        };
    }
    handleVerify(expected, mode, token, challenge, res) {
        if (mode === 'subscribe' && token && expected && token === expected) {
            res.status(common_1.HttpStatus.OK).type('text/plain').send(challenge ?? '');
            return;
        }
        this.logger.warn(`Meta verify failed (mode=${mode})`);
        res.status(common_1.HttpStatus.FORBIDDEN).type('text/plain').send('forbidden');
    }
    async handleReceive(appSecret, req, signature, res) {
        const rawBody = req.rawBody;
        if (!appSecret) {
            this.logger.error('No app secret resolved — rejecting webhook');
            res.status(common_1.HttpStatus.UNAUTHORIZED).json({ ok: false });
            return;
        }
        if (!rawBody || !signature) {
            res.status(common_1.HttpStatus.UNAUTHORIZED).json({ ok: false });
            return;
        }
        if (!this.verifySignature(signature, rawBody, appSecret)) {
            this.logger.warn('Meta webhook HMAC verification failed');
            res.status(common_1.HttpStatus.UNAUTHORIZED).json({ ok: false });
            return;
        }
        res.status(common_1.HttpStatus.OK).json({ ok: true });
        try {
            const serialKey = this.deriveSerialKey(req.body);
            await this.jobQueue.enqueue('message', { rawPayload: req.body }, serialKey ? { serialKey } : undefined);
        }
        catch (err) {
            this.logger.error(`Failed to enqueue message job: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    deriveSerialKey(body) {
        try {
            const participants = new Set();
            const entries = body?.entry ?? [];
            for (const entry of entries) {
                const changes = entry?.changes ?? [];
                for (const change of changes) {
                    const value = change?.value;
                    if (!value)
                        continue;
                    const pnid = value.metadata
                        ?.phone_number_id ?? '';
                    const messages = value.messages ?? [];
                    for (const m of messages) {
                        if (m?.from)
                            participants.add(`${pnid}:${m.from}`);
                    }
                    const statuses = value.statuses ?? [];
                    for (const s of statuses) {
                        if (s?.recipient_id)
                            participants.add(`${pnid}:${s.recipient_id}`);
                    }
                }
            }
            if (participants.size === 1) {
                return `conv:${participants.values().next().value}`;
            }
        }
        catch {
        }
        return undefined;
    }
    async verify(mode, token, challenge, res) {
        const { verifyToken } = await this.resolveSecrets();
        this.handleVerify(verifyToken, mode, token, challenge, res);
    }
    async receive(req, signature, res) {
        const { appSecret } = await this.resolveSecrets();
        await this.handleReceive(appSecret, req, signature, res);
    }
    async verifyByKey(key, mode, token, challenge, res) {
        const { verifyToken } = await this.resolveSecrets(key);
        this.handleVerify(verifyToken, mode, token, challenge, res);
    }
    async receiveByKey(key, req, signature, res) {
        const { appSecret } = await this.resolveSecrets(key);
        await this.handleReceive(appSecret, req, signature, res);
    }
    verifySignature(signatureHeader, rawBody, appSecret) {
        const expected = crypto
            .createHmac('sha256', appSecret)
            .update(rawBody)
            .digest('hex');
        const provided = signatureHeader.startsWith('sha256=')
            ? signatureHeader.slice('sha256='.length)
            : signatureHeader;
        if (provided.length !== expected.length)
            return false;
        try {
            return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
        }
        catch {
            return false;
        }
    }
};
exports.MetaWebhookController = MetaWebhookController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Query)('hub.mode')),
    __param(1, (0, common_1.Query)('hub.verify_token')),
    __param(2, (0, common_1.Query)('hub.challenge')),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, Object]),
    __metadata("design:returntype", Promise)
], MetaWebhookController.prototype, "verify", null);
__decorate([
    (0, common_1.Post)(),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Headers)('x-hub-signature-256')),
    __param(2, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], MetaWebhookController.prototype, "receive", null);
__decorate([
    (0, common_1.Get)(':key'),
    __param(0, (0, common_1.Param)('key')),
    __param(1, (0, common_1.Query)('hub.mode')),
    __param(2, (0, common_1.Query)('hub.verify_token')),
    __param(3, (0, common_1.Query)('hub.challenge')),
    __param(4, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, String, Object]),
    __metadata("design:returntype", Promise)
], MetaWebhookController.prototype, "verifyByKey", null);
__decorate([
    (0, common_1.Post)(':key'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, common_1.Param)('key')),
    __param(1, (0, common_1.Req)()),
    __param(2, (0, common_1.Headers)('x-hub-signature-256')),
    __param(3, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object, Object]),
    __metadata("design:returntype", Promise)
], MetaWebhookController.prototype, "receiveByKey", null);
exports.MetaWebhookController = MetaWebhookController = MetaWebhookController_1 = __decorate([
    (0, common_1.Controller)('webhooks/meta'),
    __metadata("design:paramtypes", [config_1.ConfigService,
        job_queue_service_1.JobQueueService,
        prisma_service_1.PrismaService,
        encryption_service_1.EncryptionService])
], MetaWebhookController);
//# sourceMappingURL=meta-webhook.controller.js.map