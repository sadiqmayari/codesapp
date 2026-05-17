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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OnboardingService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const encryption_service_1 = require("../../common/services/encryption.service");
const meta_client_service_1 = require("../inbox/meta-client.service");
const crypto = require("crypto");
const EMPTY_STATUS = {
    step: 1,
    completed: false,
    metaAppId: '',
    metaAccessTokenEncrypted: '',
    webhookVerifiedAt: null,
    testMessageSentAt: null,
};
let OnboardingService = class OnboardingService {
    constructor(prisma, encryption, metaClient) {
        this.prisma = prisma;
        this.encryption = encryption;
        this.metaClient = metaClient;
    }
    async load(companyId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { onboarding_status: true },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        const raw = (company.onboarding_status ?? {});
        return { ...EMPTY_STATUS, ...raw };
    }
    async save(companyId, status) {
        await this.prisma.company.update({
            where: { id: companyId },
            data: { onboarding_status: status },
        });
        return status;
    }
    sanitize(status) {
        return {
            step: status.step,
            completed: status.completed,
            metaAppId: status.metaAppId || null,
            metaAccessToken: status.metaAccessTokenEncrypted ? '(set)' : null,
            webhookVerifiedAt: status.webhookVerifiedAt,
            testMessageSentAt: status.testMessageSentAt,
            currentStep: status.completed ? 5 : status.step,
        };
    }
    async ensureWebhookConfig(companyId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: {
                company_name: true,
                webhook_key: true,
                webhook_verify_token: true,
            },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        let key = company.webhook_key ?? null;
        if (!key) {
            const slug = company.company_name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 40) || 'company';
            key = `${slug}-${crypto.randomBytes(6).toString('hex')}`;
            for (let attempt = 0; attempt < 6; attempt++) {
                const candidate = attempt === 0
                    ? `${slug}-${crypto.randomBytes(2).toString('hex')}`
                    : `${slug}-${crypto.randomBytes(4).toString('hex')}`;
                const clash = await this.prisma.company.findFirst({
                    where: { webhook_key: candidate },
                    select: { id: true },
                });
                if (!clash) {
                    key = candidate;
                    break;
                }
            }
        }
        const verifyToken = company.webhook_verify_token ??
            `vt_${crypto.randomBytes(16).toString('hex')}`;
        if (!company.webhook_key || !company.webhook_verify_token) {
            await this.prisma.company.update({
                where: { id: companyId },
                data: { webhook_key: key, webhook_verify_token: verifyToken },
            });
        }
        return { key, verifyToken };
    }
    async getStatus(companyId) {
        const { key, verifyToken } = await this.ensureWebhookConfig(companyId);
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: {
                webhook_app_secret_encrypted: true,
                waba_id: true,
                phone_number_id: true,
            },
        });
        return {
            ...this.sanitize(await this.load(companyId)),
            webhookKey: key,
            webhookVerifyToken: verifyToken,
            webhookSecretSet: !!company?.webhook_app_secret_encrypted,
            wabaId: company?.waba_id ?? null,
            phoneNumberId: company?.phone_number_id ?? null,
        };
    }
    async step1(companyId, dto) {
        const status = await this.load(companyId);
        status.metaAppId = dto.metaAppId;
        status.step = 2;
        return this.sanitize(await this.save(companyId, status));
    }
    async step2(companyId, dto) {
        if (this.encryption.isUsingPlaceholderKey()) {
            throw new common_1.ServiceUnavailableException('Server encryption key is not configured — refusing to store secrets. ' +
                'Set ENCRYPTION_KEY in the environment and redeploy.');
        }
        await this.ensureWebhookConfig(companyId);
        const existing = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { webhook_app_secret_encrypted: true },
        });
        const newSecret = dto.appSecret?.trim();
        if (!newSecret && !existing?.webhook_app_secret_encrypted) {
            throw new common_1.BadRequestException('Meta app secret is required (find it in your Meta app → Settings → Basic).');
        }
        if (newSecret && newSecret.length < 10) {
            throw new common_1.BadRequestException('Meta app secret looks too short.');
        }
        if (newSecret) {
            await this.prisma.company.update({
                where: { id: companyId },
                data: {
                    webhook_app_secret_encrypted: this.encryption.encrypt(newSecret),
                },
            });
        }
        const status = await this.load(companyId);
        status.webhookVerifiedAt = new Date().toISOString();
        status.step = 3;
        return this.sanitize(await this.save(companyId, status));
    }
    async step3(companyId, dto) {
        if (this.encryption.isUsingPlaceholderKey()) {
            throw new common_1.ServiceUnavailableException('Server encryption key is not configured — refusing to store secrets. ' +
                'Set ENCRYPTION_KEY in the environment and redeploy.');
        }
        const status = await this.load(companyId);
        const newToken = dto.accessToken?.trim();
        if (!newToken && !status.metaAccessTokenEncrypted) {
            throw new common_1.BadRequestException('Access token is required (paste a permanent System User token).');
        }
        if (newToken) {
            if (newToken.length < 10) {
                throw new common_1.BadRequestException('Access token looks too short.');
            }
            status.metaAccessTokenEncrypted = this.encryption.encrypt(newToken);
        }
        status.step = 4;
        return this.sanitize(await this.save(companyId, status));
    }
    async step4(companyId, dto) {
        const status = await this.load(companyId);
        await this.prisma.company.update({
            where: { id: companyId },
            data: {
                waba_id: dto.wabaId,
                phone_number_id: dto.phoneNumberId,
            },
        });
        status.step = 5;
        return this.sanitize(await this.save(companyId, status));
    }
    async step5(companyId, dto) {
        const status = await this.load(companyId);
        if (!status.metaAccessTokenEncrypted) {
            throw new common_1.ServiceUnavailableException('Access token not set — complete step 3 first.');
        }
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { phone_number_id: true },
        });
        if (!company?.phone_number_id) {
            throw new common_1.ServiceUnavailableException('Phone number not set — complete step 4 first.');
        }
        const components = dto.bodyParams && dto.bodyParams.length
            ? [
                {
                    type: 'body',
                    parameters: dto.bodyParams.map((text) => ({
                        type: 'text',
                        text,
                    })),
                },
            ]
            : undefined;
        try {
            await this.metaClient.sendTemplate(companyId, company.phone_number_id, dto.toPhone, dto.templateName, dto.languageCode, components);
        }
        catch (err) {
            const raw = err instanceof Error ? err.message : String(err);
            let detail = raw;
            const brace = raw.indexOf('{');
            if (brace !== -1) {
                try {
                    const parsed = JSON.parse(raw.slice(brace));
                    const e = parsed.error;
                    if (e) {
                        detail =
                            e.error_data?.details ||
                                e.message ||
                                detail;
                        if (e.code)
                            detail += ` (Meta code ${e.code})`;
                    }
                }
                catch {
                }
            }
            throw new common_1.BadRequestException(`WhatsApp test message failed: ${detail}. Check the template name + language code (must match the approved template exactly) and the WABA ID / Phone Number ID from Meta → WhatsApp → API Setup.`);
        }
        status.testMessageSentAt = new Date().toISOString();
        status.completed = true;
        status.step = 5;
        return this.sanitize(await this.save(companyId, status));
    }
    async completeWithoutTest(companyId) {
        const status = await this.load(companyId);
        if (!status.metaAccessTokenEncrypted) {
            throw new common_1.ServiceUnavailableException('Access token not set — complete step 3 first.');
        }
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { phone_number_id: true },
        });
        if (!company?.phone_number_id) {
            throw new common_1.ServiceUnavailableException('Phone number not set — complete step 4 first.');
        }
        status.completed = true;
        status.step = 5;
        return this.sanitize(await this.save(companyId, status));
    }
    async reset(companyId) {
        await this.prisma.company.update({
            where: { id: companyId },
            data: {
                onboarding_status: { ...EMPTY_STATUS },
                waba_id: null,
                phone_number_id: null,
            },
        });
        return this.sanitize({ ...EMPTY_STATUS });
    }
};
exports.OnboardingService = OnboardingService;
exports.OnboardingService = OnboardingService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        encryption_service_1.EncryptionService,
        meta_client_service_1.MetaClientService])
], OnboardingService);
//# sourceMappingURL=onboarding.service.js.map