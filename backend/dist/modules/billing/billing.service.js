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
const limit_notifier_service_1 = require("./limit-notifier.service");
const ai_metering_service_1 = require("../ai/ai-metering.service");
const decimal_1 = require("../../common/utils/decimal");
const DEFAULT_PAGE_SIZE = 20;
let BillingService = class BillingService {
    constructor(prisma, invoiceGen, limitNotifier, aiMetering) {
        this.prisma = prisma;
        this.invoiceGen = invoiceGen;
        this.limitNotifier = limitNotifier;
        this.aiMetering = aiMetering;
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
            include: {
                company: {
                    select: {
                        id: true,
                        company_name: true,
                        address: true,
                        logo_url: true,
                        timezone: true,
                        activated_at: true,
                        users: {
                            where: { role: 'owner' },
                            select: { name: true, email: true },
                            take: 1,
                        },
                        subscription: {
                            select: {
                                plan_name: true,
                                monthly_price: true,
                                setup_fee: true,
                            },
                        },
                    },
                },
            },
        });
        if (!inv)
            throw new common_1.NotFoundException('Invoice not found');
        const { company, ...rest } = inv;
        return (0, decimal_1.numifyDecimals)({
            ...rest,
            company: company && {
                id: company.id,
                name: company.company_name,
                address: company.address,
                logo_url: company.logo_url,
                timezone: company.timezone,
                activated_at: company.activated_at,
                owner: company.users[0] ?? null,
                plan: company.subscription,
            },
        });
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
        const [usage, contactsStored, templatesUsed] = await Promise.all([
            this.prisma.usageMetering.findUnique({
                where: { company_id_period: { company_id: companyId, period } },
            }),
            this.prisma.contact.count({
                where: { company_id: companyId, deleted_at: null },
            }),
            this.prisma.template.count({
                where: { company_id: companyId, deleted_at: null },
            }),
        ]);
        const sub = company.subscription;
        let aiUsage = null;
        if (sub.ai_enabled && company.ai_enabled && company.activated_at) {
            try {
                const idx = invoice_generator_service_1.InvoiceGeneratorService.cycleIndex(company.activated_at, new Date());
                if (idx >= 0) {
                    const cycleStart = invoice_generator_service_1.InvoiceGeneratorService.cycleStart(company.activated_at, idx);
                    const nextStart = invoice_generator_service_1.InvoiceGeneratorService.cycleStart(company.activated_at, idx + 1);
                    const costMicros = await this.aiMetering.sumCostMicros(companyId, cycleStart, new Date());
                    aiUsage = {
                        billedCents: await this.aiMetering.billedCentsFor(costMicros),
                        cycleStart: cycleStart.toISOString(),
                        nextInvoiceDate: nextStart.toISOString(),
                    };
                }
            }
            catch {
            }
        }
        return (0, decimal_1.numifyDecimals)({
            plan: sub.plan_name,
            monthlyPrice: sub.monthly_price,
            limits: {
                contactLimit: sub.contact_limit,
                templateLimit: sub.template_limit,
                userLimit: sub.user_limit,
            },
            aiUsage,
            features: {
                webhookEnabled: sub.webhook_enabled,
                aiEnabled: sub.ai_enabled && company.ai_enabled,
            },
            period,
            usage: {
                messagesSent: usage?.messages_sent ?? 0,
                contactsStored,
                templatesUsed,
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
    async rewriteLegacyInvoices(opts) {
        const CYCLE_DAYS = 30;
        const DUE_DAYS = 7;
        const DAY_MS = 86_400_000;
        const RE_CYCLE = /^INV-\d+-\d{8}$/;
        const RE_OFFCYCLE = /^INV-\d+-OFF-/;
        const isLegacy = (n) => !n || (!RE_CYCLE.test(n) && !RE_OFFCYCLE.test(n));
        const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
        const invoices = await this.prisma.invoice.findMany({
            where: opts.companyId && Number.isFinite(opts.companyId)
                ? { company_id: opts.companyId }
                : {},
            include: {
                company: {
                    select: {
                        id: true,
                        company_name: true,
                        activated_at: true,
                        subscription: { select: { plan_name: true } },
                    },
                },
            },
            orderBy: { created_at: 'asc' },
        });
        let inspected = 0;
        let candidates = 0;
        let skipped = 0;
        let updated = 0;
        const collisions = [];
        const changes = [];
        for (const inv of invoices) {
            inspected++;
            if (!isLegacy(inv.invoice_number))
                continue;
            const c = inv.company;
            if (!c?.activated_at) {
                skipped++;
                continue;
            }
            const elapsed = inv.created_at.getTime() - c.activated_at.getTime();
            const cycleIndex = Math.max(0, Math.floor(elapsed / (CYCLE_DAYS * DAY_MS)));
            const cycleStart = new Date(c.activated_at.getTime() + cycleIndex * CYCLE_DAYS * DAY_MS);
            const newNumber = `INV-${inv.company_id}-${ymd(cycleStart)}`;
            const newDueDate = new Date(cycleStart.getTime() + DUE_DAYS * DAY_MS);
            const newPeriod = cycleStart.toISOString().slice(0, 7);
            const planName = c.subscription?.plan_name ?? 'Subscription';
            const newDescription = `${planName} plan — cycle starting ${cycleStart
                .toISOString()
                .slice(0, 10)}`;
            const collision = await this.prisma.invoice.findFirst({
                where: { invoice_number: newNumber, id: { not: inv.id } },
                select: { id: true },
            });
            if (collision) {
                collisions.push({ id: inv.id, collidesWith: collision.id });
                skipped++;
                continue;
            }
            candidates++;
            changes.push({
                id: inv.id,
                companyId: inv.company_id,
                companyName: c.company_name,
                oldNumber: inv.invoice_number,
                newNumber,
                newDueDate: newDueDate.toISOString(),
                newPeriod,
            });
            if (!opts.dryRun) {
                const oldSnapshot = inv.plan_snapshot ?? {};
                const newSnapshot = {
                    ...oldSnapshot,
                    cycle_index: cycleIndex,
                    cycle_start: cycleStart.toISOString(),
                };
                try {
                    await this.prisma.invoice.update({
                        where: { id: inv.id },
                        data: {
                            invoice_number: newNumber,
                            due_date: newDueDate,
                            period: newPeriod,
                            description: newDescription,
                            plan_snapshot: newSnapshot,
                        },
                    });
                    updated++;
                }
                catch {
                    skipped++;
                }
            }
        }
        return {
            mode: opts.dryRun ? 'dry-run' : 'apply',
            inspected,
            candidates,
            skipped,
            updated,
            collisions,
            changes,
        };
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
            this.limitNotifier
                .sendSuspensionEmail(company_id)
                .catch(() => undefined);
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
        invoice_generator_service_1.InvoiceGeneratorService,
        limit_notifier_service_1.LimitNotifierService,
        ai_metering_service_1.AiMeteringService])
], BillingService);
//# sourceMappingURL=billing.service.js.map