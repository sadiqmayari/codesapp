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
var InvoiceGeneratorService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvoiceGeneratorService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
const CYCLE_DAYS = 30;
const DUE_DAYS = 7;
const DAY_MS = 86_400_000;
let InvoiceGeneratorService = InvoiceGeneratorService_1 = class InvoiceGeneratorService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(InvoiceGeneratorService_1.name);
    }
    static currentPeriod() {
        return new Date().toISOString().slice(0, 7);
    }
    static cycleIndex(activatedAt, now) {
        const elapsed = now.getTime() - activatedAt.getTime();
        if (elapsed < 0)
            return -1;
        return Math.floor(elapsed / (CYCLE_DAYS * DAY_MS));
    }
    static cycleStart(activatedAt, index) {
        return new Date(activatedAt.getTime() + index * CYCLE_DAYS * DAY_MS);
    }
    static invoiceNumber(companyId, cycleStart) {
        const ymd = cycleStart.toISOString().slice(0, 10).replace(/-/g, '');
        return `INV-${companyId}-${ymd}`;
    }
    async generateDueInvoices(now = new Date()) {
        const companies = await this.prisma.company.findMany({
            where: { activation_status: 'active', activated_at: { not: null } },
            include: { subscription: true },
        });
        let created = 0;
        let skipped = 0;
        for (const company of companies) {
            const activatedAt = company.activated_at;
            const index = InvoiceGeneratorService_1.cycleIndex(activatedAt, now);
            if (index < 0) {
                skipped++;
                continue;
            }
            const cycleStart = InvoiceGeneratorService_1.cycleStart(activatedAt, index);
            const invoiceNumber = InvoiceGeneratorService_1.invoiceNumber(company.id, cycleStart);
            const existing = await this.prisma.invoice.findUnique({
                where: { invoice_number: invoiceNumber },
            });
            if (existing) {
                skipped++;
                continue;
            }
            const sub = company.subscription;
            const dueDate = new Date(now.getTime() + DUE_DAYS * DAY_MS);
            const period = cycleStart.toISOString().slice(0, 7);
            try {
                await this.prisma.invoice.create({
                    data: {
                        company_id: company.id,
                        amount: sub.monthly_price,
                        status: 'pending',
                        due_date: dueDate,
                        invoice_number: invoiceNumber,
                        period,
                        description: `${sub.plan_name} plan — cycle starting ${cycleStart
                            .toISOString()
                            .slice(0, 10)}`,
                        plan_snapshot: {
                            plan_name: sub.plan_name,
                            monthly_price: sub.monthly_price.toString(),
                            contact_limit: sub.contact_limit,
                            template_limit: sub.template_limit,
                            user_limit: sub.user_limit,
                            cycle_index: index,
                            cycle_start: cycleStart.toISOString(),
                        },
                    },
                });
                created++;
            }
            catch (err) {
                if (err instanceof client_1.Prisma.PrismaClientKnownRequestError &&
                    err.code === 'P2002') {
                    skipped++;
                    continue;
                }
                this.logger.warn(`Invoice generation failed for company ${company.id}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return { created, skipped };
    }
};
exports.InvoiceGeneratorService = InvoiceGeneratorService;
exports.InvoiceGeneratorService = InvoiceGeneratorService = InvoiceGeneratorService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], InvoiceGeneratorService);
//# sourceMappingURL=invoice-generator.service.js.map