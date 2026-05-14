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
var UsageMeteringService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.UsageMeteringService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let UsageMeteringService = UsageMeteringService_1 = class UsageMeteringService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(UsageMeteringService_1.name);
    }
    currentPeriod() {
        return new Date().toISOString().slice(0, 7);
    }
    async increment(companyId, field, amount = 1) {
        const period = this.currentPeriod();
        await this.prisma.$executeRawUnsafe(`INSERT INTO usage_metering (company_id, period, ${field}, updated_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE ${field} = ${field} + ?, updated_at = NOW()`, companyId, period, amount, amount);
        await this.check80PercentWarning(companyId, period);
    }
    async incrementMessages(companyId) {
        await this.increment(companyId, 'messages_sent');
    }
    async incrementContacts(companyId) {
        await this.increment(companyId, 'contacts_stored');
    }
    async incrementTemplates(companyId) {
        await this.increment(companyId, 'templates_used');
    }
    async incrementWebhookCalls(companyId) {
        await this.increment(companyId, 'webhook_calls');
    }
    async incrementConversations(companyId) {
        await this.increment(companyId, 'conversations_opened');
    }
    async getUsage(companyId) {
        const period = this.currentPeriod();
        return this.prisma.usageMetering.findUnique({
            where: { company_id_period: { company_id: companyId, period } },
        });
    }
    async check80PercentWarning(companyId, period) {
        const [usage, company] = await Promise.all([
            this.prisma.usageMetering.findUnique({
                where: { company_id_period: { company_id: companyId, period } },
            }),
            this.prisma.company.findUnique({
                where: { id: companyId },
                include: { subscription: true },
            }),
        ]);
        if (!usage || !company)
            return;
        const sub = company.subscription;
        const warnings = [];
        if (usage.contacts_stored >= sub.contact_limit * 0.8)
            warnings.push('contacts');
        if (usage.templates_used >= sub.template_limit * 0.8)
            warnings.push('templates');
        if (warnings.length > 0) {
            this.logger.warn(`Company ${companyId} at 80% limit for: ${warnings.join(', ')}`);
        }
    }
};
exports.UsageMeteringService = UsageMeteringService;
exports.UsageMeteringService = UsageMeteringService = UsageMeteringService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], UsageMeteringService);
//# sourceMappingURL=usage-metering.service.js.map