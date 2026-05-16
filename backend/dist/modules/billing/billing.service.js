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
exports.BillingService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const invoice_generator_service_1 = require("./invoice-generator.service");
const DEFAULT_PAGE_SIZE = 20;
let BillingService = class BillingService {
    constructor(prisma, invoiceGen) {
        this.prisma = prisma;
        this.invoiceGen = invoiceGen;
    }
    async listInvoices(companyId, dto) {
        const page = dto.page ?? 1;
        const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
        const skip = (page - 1) * limit;
        const where = { company_id: companyId };
        if (dto.status)
            where.status = dto.status;
        const [total, rows] = await Promise.all([
            this.prisma.invoice.count({ where }),
            this.prisma.invoice.findMany({
                where,
                orderBy: { id: 'desc' },
                skip,
                take: limit,
            }),
        ]);
        return {
            success: true,
            data: rows,
            message: 'OK',
            meta: { page, limit, total },
        };
    }
    async getInvoice(companyId, id) {
        const inv = await this.prisma.invoice.findFirst({
            where: { id, company_id: companyId },
        });
        if (!inv)
            throw new common_1.NotFoundException('Invoice not found');
        return inv;
    }
    async getSubscription(companyId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            include: { subscription: true },
        });
        if (!company?.subscription) {
            throw new common_1.NotFoundException('Subscription not found');
        }
        const period = new Date().toISOString().slice(0, 7);
        const usage = await this.prisma.usageMetering.findUnique({
            where: { company_id_period: { company_id: companyId, period } },
        });
        const sub = company.subscription;
        return {
            plan: sub.plan_name,
            monthlyPrice: sub.monthly_price,
            limits: {
                contactLimit: sub.contact_limit,
                templateLimit: sub.template_limit,
                userLimit: sub.user_limit,
            },
            period,
            usage: {
                messagesSent: usage?.messages_sent ?? 0,
                contactsStored: usage?.contacts_stored ?? 0,
                templatesUsed: usage?.templates_used ?? 0,
                webhookCalls: usage?.webhook_calls ?? 0,
                conversationsOpened: usage?.conversations_opened ?? 0,
            },
        };
    }
    async overview() {
        const [byPlan, overdue] = await Promise.all([
            this.prisma.$queryRawUnsafe(`SELECT s.plan_name plan_name,
                COUNT(c.id) companies,
                SUM(s.monthly_price) mrr
         FROM companies c
         JOIN subscriptions s ON s.id = c.subscription_id
         WHERE c.activation_status = 'active'
         GROUP BY s.plan_name`),
            this.prisma.invoice.count({ where: { status: 'overdue' } }),
        ]);
        const revenueByPlan = byPlan.map((r) => ({
            plan: r.plan_name,
            companies: Number(r.companies),
            mrr: Number(r.mrr ?? 0),
        }));
        const mrr = revenueByPlan.reduce((sum, r) => sum + r.mrr, 0);
        return { mrr, revenueByPlan, overdueCount: overdue };
    }
    async markPaid(invoiceId) {
        const inv = await this.prisma.invoice.findUnique({
            where: { id: invoiceId },
        });
        if (!inv)
            throw new common_1.NotFoundException('Invoice not found');
        return this.prisma.invoice.update({
            where: { id: invoiceId },
            data: { status: 'paid', paid_at: new Date() },
        });
    }
    async generateInvoices() {
        const period = invoice_generator_service_1.InvoiceGeneratorService.currentPeriod();
        return this.invoiceGen.generateForPeriod(period);
    }
    async autoInvoiceCron() {
        const today = new Date();
        if (today.getDate() !== 1) {
            return {
                ran: false,
                reason: 'not first of month',
                day: today.getDate(),
            };
        }
        const period = invoice_generator_service_1.InvoiceGeneratorService.currentPeriod();
        const result = await this.invoiceGen.generateForPeriod(period);
        return { ran: true, ...result };
    }
};
exports.BillingService = BillingService;
exports.BillingService = BillingService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        invoice_generator_service_1.InvoiceGeneratorService])
], BillingService);
//# sourceMappingURL=billing.service.js.map