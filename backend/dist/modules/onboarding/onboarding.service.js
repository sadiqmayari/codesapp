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
    async getStatus(companyId) {
        return this.sanitize(await this.load(companyId));
    }
    async step1(companyId, dto) {
        const status = await this.load(companyId);
        status.metaAppId = dto.metaAppId;
        status.step = 2;
        return this.sanitize(await this.save(companyId, status));
    }
    async step2(companyId) {
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
        status.metaAccessTokenEncrypted = this.encryption.encrypt(dto.accessToken);
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
        await this.metaClient.sendTemplate(companyId, company.phone_number_id, dto.toPhone, dto.templateName, dto.languageCode);
        status.testMessageSentAt = new Date().toISOString();
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