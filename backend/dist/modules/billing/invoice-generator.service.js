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
const DUE_DAYS = 7;
let InvoiceGeneratorService = InvoiceGeneratorService_1 = class InvoiceGeneratorService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(InvoiceGeneratorService_1.name);
    }
    static currentPeriod() {
        return new Date().toISOString().slice(0, 7);
    }
    static invoiceNumber(period, companyId) {
        return `INV-${period.replace('-', '')}-${companyId}`;
    }
    async generateForPeriod(period) {
        const companies = await this.prisma.company.findMany({
            where: { activation_status: 'active' },
            include: { subscription: true },
        });
        let created = 0;
        let skipped = 0;
        for (const company of companies) {
            const existing = await this.prisma.invoice.findFirst({
                where: { company_id: company.id, period },
            });
            if (existing) {
                skipped++;
                continue;
            }
            const sub = company.subscription;
            const dueDate = new Date(Date.now() + DUE_DAYS * 86_400_000);
            try {
                await this.prisma.invoice.create({
                    data: {
                        company_id: company.id,
                        amount: sub.monthly_price,
                        status: 'pending',
                        due_date: dueDate,
                        invoice_number: InvoiceGeneratorService_1.invoiceNumber(period, company.id),
                        period,
                        description: `${sub.plan_name} plan — ${period}`,
                        plan_snapshot: {
                            plan_name: sub.plan_name,
                            monthly_price: sub.monthly_price.toString(),
                            contact_limit: sub.contact_limit,
                            template_limit: sub.template_limit,
                            user_limit: sub.user_limit,
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
        return { period, created, skipped };
    }
};
exports.InvoiceGeneratorService = InvoiceGeneratorService;
exports.InvoiceGeneratorService = InvoiceGeneratorService = InvoiceGeneratorService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], InvoiceGeneratorService);
//# sourceMappingURL=invoice-generator.service.js.map