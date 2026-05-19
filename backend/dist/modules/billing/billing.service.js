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
const decimal_1 = require("../../common/utils/decimal");
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
            data: (0, decimal_1.numifyDecimals)(rows),
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
        return (0, decimal_1.numifyDecimals)(inv);
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
        return (0, decimal_1.numifyDecimals)({
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
        });
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
        const wasUnpaid = inv.status === 'pending' || inv.status === 'overdue';
        const updated = await this.prisma.invoice.update({
            where: { id: invoiceId },
            data: { status: 'paid', paid_at: new Date() },
        });
        if (wasUnpaid) {
            await this.maybeReactivate(inv.company_id);
        }
        return updated;
    }
    async maybeReactivate(companyId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { activation_status: true, suspended_at: true },
        });
        if (!company ||
            company.activation_status !== 'suspended' ||
            !company.suspended_at) {
            return;
        }
        const stillOwes = await this.prisma.invoice.count({
            where: { company_id: companyId, status: { in: ['pending', 'overdue'] } },
        });
        if (stillOwes > 0)
            return;
        await this.prisma.company.update({
            where: { id: companyId },
            data: { activation_status: 'active', suspended_at: null },
        });
    }
    async generateInvoices() {
        return this.invoiceGen.generateDueInvoices();
    }
    async autoInvoiceCron() {
        const result = await this.invoiceGen.generateDueInvoices();
        return { ran: true, ...result };
    }
    async enforceCron() {
        const SUSPEND_GRACE_DAYS = 3;
        const now = new Date();
        const flagged = await this.prisma.invoice.updateMany({
            where: { status: 'pending', due_date: { lt: now } },
            data: { status: 'overdue' },
        });
        const suspendThreshold = new Date(now.getTime() - SUSPEND_GRACE_DAYS * 86_400_000);
        const delinquent = await this.prisma.invoice.findMany({
            where: { status: 'overdue', due_date: { lt: suspendThreshold } },
            select: { company_id: true },
            distinct: ['company_id'],
        });
        let suspended = 0;
        for (const { company_id } of delinquent) {
            const company = await this.prisma.company.findUnique({
                where: { id: company_id },
                select: { activation_status: true, grace_until: true },
            });
            if (!company || company.activation_status !== 'active')
                continue;
            if (company.grace_until && company.grace_until > now)
                continue;
            await this.prisma.company.update({
                where: { id: company_id },
                data: { activation_status: 'suspended', suspended_at: now },
            });
            suspended++;
        }
        return {
            ran: true,
            markedOverdue: flagged.count,
            suspended,
        };
    }
    async accountStatus(companyId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { activation_status: true, suspended_at: true, grace_until: true },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        const unpaid = await this.prisma.invoice.findMany({
            where: {
                company_id: companyId,
                status: { in: ['pending', 'overdue'] },
            },
            orderBy: { due_date: 'asc' },
        });
        const suspendedForBilling = company.activation_status === 'suspended' &&
            !!company.suspended_at &&
            unpaid.length > 0;
        return (0, decimal_1.numifyDecimals)({
            activationStatus: company.activation_status,
            suspendedForBilling,
            suspendedAt: company.suspended_at,
            graceUntil: company.grace_until,
            unpaidInvoices: unpaid,
        });
    }
};
exports.BillingService = BillingService;
exports.BillingService = BillingService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        invoice_generator_service_1.InvoiceGeneratorService])
], BillingService);
//# sourceMappingURL=billing.service.js.map