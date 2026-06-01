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
var CsvImportService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CsvImportService = void 0;
const common_1 = require("@nestjs/common");
const csv_parse_1 = require("csv-parse");
const stream_1 = require("stream");
const prisma_service_1 = require("../../prisma/prisma.service");
const usage_metering_service_1 = require("../usage-metering/usage-metering.service");
const cache_service_1 = require("../../common/services/cache.service");
const create_contact_dto_1 = require("./dto/create-contact.dto");
let CsvImportService = CsvImportService_1 = class CsvImportService {
    constructor(prisma, metering, cache) {
        this.prisma = prisma;
        this.metering = metering;
        this.cache = cache;
        this.logger = new common_1.Logger(CsvImportService_1.name);
    }
    async import(companyId, fileBuffer) {
        const subscription = await this.getSubscription(companyId);
        let currentStored = await this.prisma.contact.count({
            where: { company_id: companyId, deleted_at: null },
        });
        const summary = {
            created: 0,
            skipped: 0,
            invalid: 0,
            capped: false,
        };
        const parser = (0, csv_parse_1.parse)({
            columns: true,
            skip_empty_lines: true,
            trim: true,
        });
        const source = stream_1.Readable.from(fileBuffer);
        source.pipe(parser);
        for await (const row of parser) {
            const phone = (row.phone ?? '').trim();
            if (!create_contact_dto_1.PHONE_REGEX.test(phone)) {
                summary.invalid++;
                continue;
            }
            if (currentStored >= subscription.contact_limit) {
                summary.capped = true;
                break;
            }
            const existing = await this.prisma.contact.findFirst({
                where: {
                    company_id: companyId,
                    phone,
                    deleted_at: null,
                },
                select: { id: true },
            });
            if (existing) {
                summary.skipped++;
                continue;
            }
            const tags = (row.tags ?? '')
                .split(',')
                .map((t) => t.trim())
                .filter((t) => t.length > 0);
            try {
                await this.prisma.contact.create({
                    data: {
                        company_id: companyId,
                        name: (row.name ?? phone).slice(0, 255),
                        phone,
                        email: row.email?.trim() || null,
                        tags,
                        custom_fields: {},
                    },
                });
                await this.metering.incrementContacts(companyId);
                currentStored++;
                summary.created++;
            }
            catch (err) {
                this.logger.warn(`CSV row insert failed (phone=${phone}): ${err instanceof Error ? err.message : String(err)}`);
                summary.invalid++;
            }
        }
        return summary;
    }
    async getSubscription(companyId) {
        const cacheKey = this.cache.subscriptionKey(companyId);
        const cached = this.cache.get(cacheKey);
        if (cached)
            return cached;
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            include: { subscription: { select: { contact_limit: true } } },
        });
        if (!company)
            throw new Error('Company not found');
        this.cache.set(cacheKey, company.subscription, 300);
        return company.subscription;
    }
};
exports.CsvImportService = CsvImportService;
exports.CsvImportService = CsvImportService = CsvImportService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        usage_metering_service_1.UsageMeteringService,
        cache_service_1.CacheService])
], CsvImportService);
//# sourceMappingURL=csv-import.service.js.map