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
var AiMeteringService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiMeteringService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const platform_setting_service_1 = require("../../common/services/platform-setting.service");
const ai_constants_1 = require("./ai.constants");
let AiMeteringService = AiMeteringService_1 = class AiMeteringService {
    constructor(prisma, platformSetting) {
        this.prisma = prisma;
        this.platformSetting = platformSetting;
        this.logger = new common_1.Logger(AiMeteringService_1.name);
    }
    currentPeriod() {
        return new Date().toISOString().slice(0, 7);
    }
    computeCostMicros(provider, tier, usage) {
        const m = ai_constants_1.PROVIDER_MODELS[provider][tier];
        const cost = usage.inputTokens * m.inMicros +
            usage.outputTokens * m.outMicros +
            usage.cacheReadTokens * m.inMicros * ai_constants_1.CACHE_READ_MULTIPLIER +
            usage.cacheWriteTokens * m.inMicros * ai_constants_1.CACHE_WRITE_MULTIPLIER;
        return Math.round(cost);
    }
    async getMultiplier() {
        const v = await this.platformSetting.get(ai_constants_1.AI_PRICE_MULTIPLIER_KEY, ai_constants_1.AI_PRICE_MULTIPLIER_DEFAULT);
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : 1.5;
    }
    toBilledCents(costMicros, multiplier) {
        return Math.ceil((costMicros * multiplier) / 10000);
    }
    async getCapCents(companyOverride) {
        if (companyOverride !== null && companyOverride !== undefined) {
            return companyOverride;
        }
        const v = await this.platformSetting.get(ai_constants_1.AI_DEFAULT_CAP_KEY, ai_constants_1.AI_DEFAULT_CAP_DEFAULT);
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    }
    async assertAllowed(companyId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: {
                ai_enabled: true,
                ai_monthly_cap_cents: true,
                subscription: { select: { ai_enabled: true } },
            },
        });
        if (!company)
            throw new common_1.ForbiddenException('Company not found.');
        if (!company.subscription?.ai_enabled) {
            throw new common_1.ForbiddenException('AI is not included in your plan.');
        }
        if (!company.ai_enabled) {
            throw new common_1.ForbiddenException('AI is disabled for your account.');
        }
        const cap = await this.getCapCents(company.ai_monthly_cap_cents);
        if (cap > 0) {
            const usage = await this.getMonthlyUsage(companyId, company.ai_monthly_cap_cents);
            if (usage.billedCents >= cap) {
                throw new common_1.ForbiddenException('Monthly AI usage limit reached. Contact your administrator.');
            }
        }
    }
    async recordUsage(companyId, userId, feature, provider, tier, usage) {
        const period = this.currentPeriod();
        const modelId = ai_constants_1.PROVIDER_MODELS[provider][tier].id;
        const costMicros = this.computeCostMicros(provider, tier, usage);
        const totalInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
        try {
            await this.prisma.aiUsageLog.create({
                data: {
                    company_id: companyId,
                    user_id: userId ?? undefined,
                    period,
                    feature,
                    model: modelId,
                    input_tokens: totalInput,
                    output_tokens: usage.outputTokens,
                    cost_micros: BigInt(costMicros),
                },
            });
            await this.prisma.$executeRawUnsafe(`INSERT INTO usage_metering
           (company_id, period, ai_requests, ai_input_tokens, ai_output_tokens, ai_cost_micros, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           ai_requests = ai_requests + 1,
           ai_input_tokens = ai_input_tokens + ?,
           ai_output_tokens = ai_output_tokens + ?,
           ai_cost_micros = ai_cost_micros + ?,
           updated_at = NOW()`, companyId, period, totalInput, usage.outputTokens, costMicros, totalInput, usage.outputTokens, costMicros);
        }
        catch (e) {
            this.logger.error(`AI usage metering failed for company ${companyId} (${feature}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async recordTranscription(companyId, costMicros) {
        const period = this.currentPeriod();
        const micros = Math.max(0, Math.round(costMicros));
        try {
            await this.prisma.aiUsageLog.create({
                data: {
                    company_id: companyId,
                    period,
                    feature: 'transcription',
                    model: 'whisper-1',
                    input_tokens: 0,
                    output_tokens: 0,
                    cost_micros: BigInt(micros),
                },
            });
            await this.prisma.$executeRawUnsafe(`INSERT INTO usage_metering
           (company_id, period, ai_requests, ai_input_tokens, ai_output_tokens, ai_cost_micros, updated_at)
         VALUES (?, ?, 1, 0, 0, ?, NOW())
         ON DUPLICATE KEY UPDATE
           ai_requests = ai_requests + 1,
           ai_cost_micros = ai_cost_micros + ?,
           updated_at = NOW()`, companyId, period, micros, micros);
        }
        catch (e) {
            this.logger.error(`AI transcription metering failed for company ${companyId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async recordEmbedding(companyId, tokens, costMicros) {
        const period = this.currentPeriod();
        const micros = Math.max(0, Math.round(costMicros));
        const tok = Math.max(0, Math.round(tokens));
        try {
            await this.prisma.aiUsageLog.create({
                data: {
                    company_id: companyId,
                    period,
                    feature: 'embedding',
                    model: 'text-embedding-3-small',
                    input_tokens: tok,
                    output_tokens: 0,
                    cost_micros: BigInt(micros),
                },
            });
            await this.prisma.$executeRawUnsafe(`INSERT INTO usage_metering
           (company_id, period, ai_requests, ai_input_tokens, ai_output_tokens, ai_cost_micros, updated_at)
         VALUES (?, ?, 1, ?, 0, ?, NOW())
         ON DUPLICATE KEY UPDATE
           ai_requests = ai_requests + 1,
           ai_input_tokens = ai_input_tokens + ?,
           ai_cost_micros = ai_cost_micros + ?,
           updated_at = NOW()`, companyId, period, tok, micros, tok, micros);
        }
        catch (e) {
            this.logger.error(`AI embedding metering failed for company ${companyId}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async getMonthlyUsage(companyId, capOverride) {
        const period = this.currentPeriod();
        const [row, multiplier] = await Promise.all([
            this.prisma.usageMetering.findUnique({
                where: { company_id_period: { company_id: companyId, period } },
                select: {
                    ai_requests: true,
                    ai_input_tokens: true,
                    ai_output_tokens: true,
                    ai_cost_micros: true,
                },
            }),
            this.getMultiplier(),
        ]);
        const costMicros = Number(row?.ai_cost_micros ?? 0n);
        const cap = capOverride !== undefined
            ? await this.getCapCents(capOverride)
            : await this.resolveCapForCompany(companyId);
        return {
            period,
            requests: row?.ai_requests ?? 0,
            inputTokens: row?.ai_input_tokens ?? 0,
            outputTokens: row?.ai_output_tokens ?? 0,
            costMicros,
            billedCents: this.toBilledCents(costMicros, multiplier),
            capCents: cap,
            multiplier,
        };
    }
    async resolveCapForCompany(companyId) {
        const c = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { ai_monthly_cap_cents: true },
        });
        return this.getCapCents(c?.ai_monthly_cap_cents ?? null);
    }
    async sumCostMicros(companyId, from, to) {
        const agg = await this.prisma.aiUsageLog.aggregate({
            where: { company_id: companyId, created_at: { gte: from, lt: to } },
            _sum: { cost_micros: true },
        });
        return Number(agg._sum.cost_micros ?? 0n);
    }
    async billedCentsFor(costMicros) {
        const multiplier = await this.getMultiplier();
        return this.toBilledCents(costMicros, multiplier);
    }
};
exports.AiMeteringService = AiMeteringService;
exports.AiMeteringService = AiMeteringService = AiMeteringService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        platform_setting_service_1.PlatformSettingService])
], AiMeteringService);
//# sourceMappingURL=ai-metering.service.js.map