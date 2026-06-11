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
var SuperAdminService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SuperAdminService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const bcrypt = require("bcryptjs");
const prisma_service_1 = require("../../prisma/prisma.service");
const cache_service_1 = require("../../common/services/cache.service");
const decimal_1 = require("../../common/utils/decimal");
const platform_setting_service_1 = require("../../common/services/platform-setting.service");
const limit_notifier_service_1 = require("../billing/limit-notifier.service");
const company_status_service_1 = require("../../common/services/company-status.service");
const mail_service_1 = require("../../common/services/mail.service");
const public_service_1 = require("../public/public.service");
function n(v) {
    if (typeof v === 'bigint')
        return Number(v);
    if (v === null || v === undefined)
        return 0;
    return Number(v);
}
let SuperAdminService = SuperAdminService_1 = class SuperAdminService {
    constructor(prisma, jwt, config, platformSetting, limitNotifier, cache, companyStatus, mail) {
        this.prisma = prisma;
        this.jwt = jwt;
        this.config = config;
        this.platformSetting = platformSetting;
        this.limitNotifier = limitNotifier;
        this.cache = cache;
        this.companyStatus = companyStatus;
        this.mail = mail;
        this.logger = new common_1.Logger(SuperAdminService_1.name);
    }
    async getSettings() {
        return {
            usageLimitAction: await this.platformSetting.getUsageLimitAction(),
            aiProvider: await this.platformSetting.get('ai_provider', 'anthropic'),
            aiAutonomousTier: await this.platformSetting.getAutonomousTier(),
        };
    }
    async updateSettings(usageLimitAction, aiProvider, aiAutonomousTier) {
        await this.platformSetting.setUsageLimitAction(usageLimitAction);
        if (aiProvider) {
            await this.platformSetting.set('ai_provider', aiProvider);
        }
        if (aiAutonomousTier) {
            await this.platformSetting.setAutonomousTier(aiAutonomousTier);
        }
        return {
            usageLimitAction,
            aiProvider: await this.platformSetting.get('ai_provider', 'anthropic'),
            aiAutonomousTier: await this.platformSetting.getAutonomousTier(),
        };
    }
    async login(email, password, res) {
        const user = await this.prisma.user.findUnique({ where: { email } });
        if (!user || user.role !== 'super_admin') {
            throw new common_1.UnauthorizedException('Invalid credentials');
        }
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid)
            throw new common_1.UnauthorizedException('Invalid credentials');
        const payload = {
            sub: user.id,
            companyId: null,
            role: 'super_admin',
            email: user.email,
        };
        const accessToken = this.jwt.sign(payload, {
            secret: this.config.get('JWT_SECRET'),
            expiresIn: '2h',
        });
        const refreshToken = this.jwt.sign(payload, {
            secret: this.config.get('JWT_REFRESH_SECRET'),
            expiresIn: '1d',
        });
        res.cookie('sa_refresh_token', refreshToken, {
            httpOnly: true,
            secure: this.config.get('NODE_ENV') === 'production',
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000,
            path: '/',
        });
        return { accessToken };
    }
    async refresh(refreshToken, res) {
        if (!refreshToken)
            throw new common_1.UnauthorizedException('No session');
        let payload;
        try {
            payload = this.jwt.verify(refreshToken, {
                secret: this.config.get('JWT_REFRESH_SECRET'),
            });
        }
        catch {
            throw new common_1.UnauthorizedException('Invalid session');
        }
        const user = await this.prisma.user.findUnique({
            where: { id: payload.sub },
        });
        if (!user || user.role !== 'super_admin') {
            throw new common_1.UnauthorizedException('Invalid session');
        }
        const newPayload = {
            sub: user.id,
            companyId: null,
            role: 'super_admin',
            email: user.email,
        };
        const accessToken = this.jwt.sign(newPayload, {
            secret: this.config.get('JWT_SECRET'),
            expiresIn: '2h',
        });
        const newRefresh = this.jwt.sign(newPayload, {
            secret: this.config.get('JWT_REFRESH_SECRET'),
            expiresIn: '1d',
        });
        res.cookie('sa_refresh_token', newRefresh, {
            httpOnly: true,
            secure: this.config.get('NODE_ENV') === 'production',
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000,
            path: '/',
        });
        return { accessToken };
    }
    logout(res) {
        res.clearCookie('sa_refresh_token', {
            httpOnly: true,
            secure: this.config.get('NODE_ENV') === 'production',
            sameSite: 'lax',
            path: '/',
        });
        return { message: 'Logged out' };
    }
    async getDashboard() {
        const now = new Date();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);
        const [counts, totalUsers, mrr, invoicedThisMonth, paidThisMonth, outstanding, newSignups, activeConvosToday, signups90d, pendingApprovals, overdueInvoices, recentActivity,] = await Promise.all([
            this.prisma.$queryRawUnsafe(`SELECT
           SUM(activation_status='active') active,
           SUM(activation_status='pending') pending,
           SUM(activation_status='suspended') suspended
         FROM companies`),
            this.prisma.user.count({ where: { role: { not: 'super_admin' } } }),
            this.prisma.$queryRawUnsafe(`SELECT COALESCE(SUM(s.monthly_price), 0) v
         FROM companies c JOIN subscriptions s ON s.id = c.subscription_id
         WHERE c.activation_status = 'active'`),
            this.prisma.$queryRawUnsafe(`SELECT COALESCE(SUM(amount), 0) v FROM invoices
         WHERE created_at >= ?`, monthStart),
            this.prisma.$queryRawUnsafe(`SELECT COALESCE(SUM(amount), 0) v FROM invoices
         WHERE paid_at IS NOT NULL AND paid_at >= ?`, monthStart),
            this.prisma.$queryRawUnsafe(`SELECT COALESCE(SUM(amount), 0) v FROM invoices
         WHERE status IN ('pending','overdue')`),
            this.prisma.company.count({
                where: { created_at: { gte: monthStart } },
            }),
            this.prisma.conversation.count({
                where: { deleted_at: null, last_message_at: { gte: dayStart } },
            }),
            this.prisma.$queryRawUnsafe(`SELECT DATE(created_at) d, COUNT(*) c
         FROM companies
         WHERE created_at >= ?
         GROUP BY DATE(created_at)
         ORDER BY d`, ninetyDaysAgo),
            this.prisma.company.findMany({
                where: { activation_status: 'pending' },
                orderBy: { created_at: 'desc' },
                take: 5,
                include: {
                    users: {
                        where: { role: 'owner' },
                        select: { name: true, email: true },
                        take: 1,
                    },
                },
            }),
            this.prisma.$queryRawUnsafe(`SELECT i.id, i.invoice_number, i.company_id, c.company_name,
                i.amount, i.due_date,
                GREATEST(0, DATEDIFF(NOW(), i.due_date)) days_overdue
         FROM invoices i JOIN companies c ON c.id = i.company_id
         WHERE i.status IN ('pending','overdue') AND i.due_date < NOW()
         ORDER BY i.due_date ASC
         LIMIT 5`),
            this.prisma.auditLog.findMany({
                orderBy: { created_at: 'desc' },
                take: 10,
                include: {
                    user: { select: { name: true, email: true } },
                },
            }),
        ]);
        const dec = (rows) => Math.round(Number(rows?.[0]?.v ?? 0) * 100) / 100;
        return (0, decimal_1.numifyDecimals)({
            kpis: {
                totalClients: n(counts[0]?.active) +
                    n(counts[0]?.pending) +
                    n(counts[0]?.suspended),
                activeClients: n(counts[0]?.active),
                pendingClients: n(counts[0]?.pending),
                suspendedClients: n(counts[0]?.suspended),
                totalUsers,
                mrrUsd: dec(mrr),
                invoicedThisMonthUsd: dec(invoicedThisMonth),
                paidThisMonthUsd: dec(paidThisMonth),
                outstandingUsd: dec(outstanding),
                newSignupsThisMonth: newSignups,
                activeConversationsToday: activeConvosToday,
            },
            signups90d: signups90d.map((r) => ({
                date: r.d,
                count: n(r.c),
            })),
            pendingApprovals: pendingApprovals.map((c) => ({
                id: c.id,
                name: c.company_name,
                createdAt: c.created_at.toISOString(),
                ownerName: c.users[0]?.name ?? null,
                ownerEmail: c.users[0]?.email ?? null,
            })),
            overdueInvoices: overdueInvoices.map((r) => ({
                id: r.id,
                invoiceNumber: r.invoice_number,
                companyId: r.company_id,
                companyName: r.company_name,
                amount: Math.round(Number(r.amount) * 100) / 100,
                dueDate: r.due_date.toISOString(),
                daysOverdue: Number(r.days_overdue),
            })),
            recentActivity: recentActivity.map((a) => ({
                id: a.id,
                action: a.action,
                entity: a.entity,
                entityId: a.entity_id,
                createdAt: a.created_at.toISOString(),
                userName: a.user?.name ?? null,
                userEmail: a.user?.email ?? null,
            })),
        });
    }
    async getClients(page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const [items, total] = await Promise.all([
            this.prisma.company.findMany({
                skip,
                take: limit,
                include: { subscription: true },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.company.count(),
        ]);
        return (0, decimal_1.numifyDecimals)({ items, meta: { page, limit, total } });
    }
    async getClient(id) {
        const company = await this.prisma.company.findUnique({
            where: { id },
            include: {
                subscription: true,
                users: { select: { id: true, name: true, email: true, role: true, status: true } },
            },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        return (0, decimal_1.numifyDecimals)(company);
    }
    async getClientDetail(id) {
        const company = await this.prisma.company.findUnique({
            where: { id },
            include: {
                subscription: true,
                users: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        role: true,
                        status: true,
                        created_at: true,
                    },
                    orderBy: { created_at: 'asc' },
                },
            },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        const period = new Date().toISOString().slice(0, 7);
        const [activeContacts, totalContacts, templatesCount, activeUsersCount, openInvoicesAgg, windowOpenChats, messagesThisMonthAgg, conversationsThisMonthCount, usage, invoices, shopify, audit,] = await Promise.all([
            this.prisma.contact.count({
                where: { company_id: id, deleted_at: null, status: { not: 'blocked' } },
            }),
            this.prisma.contact.count({
                where: { company_id: id, deleted_at: null },
            }),
            this.prisma.template.count({
                where: { company_id: id, deleted_at: null },
            }),
            this.prisma.user.count({
                where: { company_id: id, status: 'active' },
            }),
            this.prisma.invoice.aggregate({
                where: { company_id: id, status: { in: ['pending', 'overdue'] } },
                _sum: { amount: true },
                _count: { _all: true },
            }),
            this.prisma.conversation.count({
                where: {
                    company_id: id,
                    deleted_at: null,
                    window_expires_at: { gt: new Date() },
                },
            }),
            this.prisma.message.count({
                where: {
                    company_id: id,
                    direction: 'outbound',
                    timestamp: {
                        gte: new Date(`${period}-01T00:00:00.000Z`),
                    },
                },
            }),
            this.prisma.conversation.count({
                where: {
                    company_id: id,
                    deleted_at: null,
                    created_at: {
                        gte: new Date(`${period}-01T00:00:00.000Z`),
                    },
                },
            }),
            this.prisma.usageMetering.findUnique({
                where: { company_id_period: { company_id: id, period } },
            }),
            this.prisma.invoice.findMany({
                where: { company_id: id },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.shopifyIntegration.findFirst({
                where: { company_id: id },
                select: {
                    id: true,
                    shop_domain: true,
                    status: true,
                    active_events: true,
                    created_at: true,
                },
            }),
            this.prisma.auditLog.findMany({
                where: { company_id: id },
                orderBy: { created_at: 'desc' },
                take: 50,
                include: {
                    user: { select: { id: true, name: true, email: true } },
                },
            }),
        ]);
        const monthlyPrice = Number(company.subscription?.monthly_price ?? 0);
        const mrrUsd = company.activation_status === 'active' ? monthlyPrice : 0;
        const effectiveUsageLimitAction = company.usage_limit_action ??
            (await this.platformSetting.getUsageLimitAction());
        return (0, decimal_1.numifyDecimals)({
            company: {
                id: company.id,
                name: company.company_name,
                address: company.address,
                activation_status: company.activation_status,
                activated_at: company.activated_at,
                suspended_at: company.suspended_at,
                grace_until: company.grace_until,
                usage_limit_action: company.usage_limit_action,
                effective_usage_limit_action: effectiveUsageLimitAction,
                contact_limit_override: company.contact_limit_override,
                template_limit_override: company.template_limit_override,
                user_limit_override: company.user_limit_override,
                effective_limits: company.subscription
                    ? {
                        contact_limit: company.contact_limit_override ??
                            company.subscription.contact_limit,
                        template_limit: company.template_limit_override ??
                            company.subscription.template_limit,
                        user_limit: company.user_limit_override ??
                            company.subscription.user_limit,
                    }
                    : null,
                logo_url: company.logo_url,
                timezone: company.timezone,
                created_at: company.created_at,
                waba_id: company.waba_id,
                phone_number_id: company.phone_number_id,
                webhook_key: company.webhook_key,
                has_webhook_app_secret: !!company.webhook_app_secret_encrypted,
                shopify_webhook_key: company.shopify_webhook_key,
                has_shopify_webhook_secret: !!company.shopify_webhook_secret_encrypted,
                has_shopify_admin_token: !!company.shopify_admin_token_encrypted,
                default_country_code: company.default_country_code,
                onboarding_status: company.onboarding_status,
                ai_premium_locked: company.ai_premium_locked,
                ai_autonomous_tier: company.ai_autonomous_tier,
                ai_vision_enabled: company.ai_vision_enabled,
                ai_voice_enabled: company.ai_voice_enabled,
            },
            subscription: company.subscription,
            users: company.users,
            snapshot: {
                period,
                mrrUsd,
                activeContacts,
                totalContacts,
                templates: templatesCount,
                activeUsers: activeUsersCount,
                openInvoices: openInvoicesAgg._count._all,
                outstandingUsd: Number(openInvoicesAgg._sum.amount ?? 0),
                windowOpenChats,
                messagesThisMonth: messagesThisMonthAgg,
                conversationsThisMonth: conversationsThisMonthCount,
            },
            usage: {
                ...(usage ?? {}),
                contacts_stored: totalContacts,
                templates_used: templatesCount,
            },
            invoices,
            shopify,
            audit: audit.map((a) => ({
                id: a.id,
                action: a.action,
                entity: a.entity,
                entity_id: a.entity_id,
                ip_address: a.ip_address,
                metadata: a.metadata,
                created_at: a.created_at,
                user: a.user,
            })),
        });
    }
    async activateClient(id) {
        return this.prisma.$transaction(async (tx) => {
            const existing = await tx.company.findUnique({
                where: { id },
                select: { activated_at: true },
            });
            const company = await tx.company.update({
                where: { id },
                data: {
                    activation_status: 'active',
                    ...(existing?.activated_at ? {} : { activated_at: new Date() }),
                    suspended_at: null,
                },
            });
            await tx.user.updateMany({
                where: { company_id: id, role: 'owner' },
                data: { status: 'active' },
            });
            return company;
        }).then((company) => {
            this.companyStatus.invalidate(id);
            return company;
        });
    }
    async suspendClient(id) {
        const before = await this.prisma.company.findUnique({
            where: { id },
            select: { activation_status: true },
        });
        const updated = await this.prisma.company.update({
            where: { id },
            data: { activation_status: 'suspended', suspended_at: new Date() },
        });
        if (before?.activation_status !== 'suspended') {
            this.limitNotifier.sendSuspensionEmail(id).catch(() => undefined);
        }
        this.companyStatus.invalidate(id);
        return updated;
    }
    async setLimitOverrides(id, body) {
        const company = await this.prisma.company.findUnique({
            where: { id },
            select: { id: true },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        const norm = (v) => {
            if (v === null)
                return null;
            if (v === undefined)
                return undefined;
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) {
                throw new common_1.BadRequestException('Limit override must be >= 0');
            }
            return Math.floor(n);
        };
        const data = {};
        if ('contact_limit' in body) {
            const v = norm(body.contact_limit ?? null);
            if (v !== undefined)
                data.contact_limit_override = v;
        }
        if ('template_limit' in body) {
            const v = norm(body.template_limit ?? null);
            if (v !== undefined)
                data.template_limit_override = v;
        }
        if ('user_limit' in body) {
            const v = norm(body.user_limit ?? null);
            if (v !== undefined)
                data.user_limit_override = v;
        }
        const updated = await this.prisma.company.update({
            where: { id },
            data,
        });
        this.cache.del(this.cache.subscriptionKey(id));
        return updated;
    }
    async grantGrace(id, until) {
        const company = await this.prisma.company.findUnique({
            where: { id },
            select: { activation_status: true, suspended_at: true },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        const reactivate = until !== null &&
            until > new Date() &&
            company.activation_status === 'suspended' &&
            !!company.suspended_at;
        const updated = await this.prisma.company.update({
            where: { id },
            data: {
                grace_until: until,
                ...(reactivate
                    ? { activation_status: 'active', suspended_at: null }
                    : {}),
            },
        });
        if (reactivate)
            this.companyStatus.invalidate(id);
        return updated;
    }
    async listPlanRequests(status) {
        const rows = await this.prisma.planChangeRequest.findMany({
            where: status ? { status } : {},
            orderBy: { id: 'desc' },
            take: 200,
            include: { company: { select: { id: true, company_name: true } } },
        });
        const subIds = Array.from(new Set(rows
            .flatMap((r) => [r.requested_subscription_id, r.current_subscription_id])
            .filter((x) => typeof x === 'number')));
        const subs = subIds.length
            ? await this.prisma.subscription.findMany({
                where: { id: { in: subIds } },
                select: { id: true, plan_name: true },
            })
            : [];
        const nameOf = new Map(subs.map((s) => [s.id, s.plan_name]));
        return rows.map((r) => ({
            ...r,
            requestedPlanName: r.requested_subscription_id
                ? (nameOf.get(r.requested_subscription_id) ?? null)
                : null,
            currentPlanName: r.current_subscription_id
                ? (nameOf.get(r.current_subscription_id) ?? null)
                : null,
        }));
    }
    async resolvePlanRequest(id, action, note) {
        const req = await this.prisma.planChangeRequest.findUnique({
            where: { id },
        });
        if (!req)
            throw new common_1.NotFoundException('Request not found');
        if (req.status !== 'pending') {
            throw new common_1.BadRequestException('Request is already resolved.');
        }
        if (action === 'approve' && req.requested_subscription_id) {
            await this.prisma.company.update({
                where: { id: req.company_id },
                data: { subscription_id: req.requested_subscription_id },
            });
            this.cache.del(this.cache.subscriptionKey(req.company_id));
        }
        const updated = await this.prisma.planChangeRequest.update({
            where: { id },
            data: {
                status: action === 'approve' ? 'approved' : 'rejected',
                resolved_at: new Date(),
                resolution_note: note?.trim() || null,
            },
        });
        const owner = await this.prisma.user.findFirst({
            where: { company_id: req.company_id, role: 'owner' },
            select: { email: true },
        });
        if (owner?.email) {
            void this.mail.send(owner.email, `Your plan-change request was ${updated.status}`, `<p>Your plan-change request has been <strong>${updated.status}</strong>.</p>` +
                (note ? `<p>${note}</p>` : '') +
                `<p>You can review your plan in Billing.</p>`);
        }
        return updated;
    }
    async setUsageLimitAction(id, action) {
        return this.prisma.company.update({
            where: { id },
            data: { usage_limit_action: action },
        });
    }
    async setAiCapabilities(id, caps) {
        const company = await this.prisma.company.findUnique({
            where: { id },
            select: { id: true },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        const data = {};
        if (caps.premiumLocked !== undefined) {
            data.ai_premium_locked = caps.premiumLocked;
        }
        const updated = await this.prisma.company.update({
            where: { id },
            data,
            select: { ai_premium_locked: true },
        });
        this.cache.del(this.cache.subscriptionKey(id));
        return updated;
    }
    async createOneOffInvoice(companyId, data) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: { id: true },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        const amt = Number(data.amount);
        if (!Number.isFinite(amt) || amt <= 0) {
            throw new common_1.BadRequestException('Amount must be > 0');
        }
        const now = new Date();
        const ts = now.toISOString().slice(2, 10).replace(/-/g, '') +
            '-' +
            now.toISOString().slice(11, 19).replace(/:/g, '');
        const invoiceNumber = `INV-${companyId}-OFF-${ts}`;
        const due = data.dueDate && data.dueDate.length > 0
            ? new Date(data.dueDate)
            : new Date(now.getTime() + 7 * 86_400_000);
        const created = await this.prisma.invoice.create({
            data: {
                company_id: companyId,
                amount: amt,
                status: 'pending',
                due_date: due,
                invoice_number: invoiceNumber,
                description: data.description?.trim() || null,
                period: null,
            },
        });
        return (0, decimal_1.numifyDecimals)(created);
    }
    async deleteClient(id) {
        const company = await this.prisma.company.findUnique({ where: { id } });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        await this.prisma.$transaction([
            this.prisma.message.deleteMany({ where: { company_id: id } }),
            this.prisma.conversation.deleteMany({ where: { company_id: id } }),
            this.prisma.contact.deleteMany({ where: { company_id: id } }),
            this.prisma.template.deleteMany({ where: { company_id: id } }),
            this.prisma.bot.deleteMany({ where: { company_id: id } }),
            this.prisma.broadcast.deleteMany({ where: { company_id: id } }),
            this.prisma.webhookLog.deleteMany({ where: { company_id: id } }),
            this.prisma.webhookEndpoint.deleteMany({ where: { company_id: id } }),
            this.prisma.invoice.deleteMany({ where: { company_id: id } }),
            this.prisma.auditLog.deleteMany({ where: { company_id: id } }),
            this.prisma.usageMetering.deleteMany({ where: { company_id: id } }),
            this.prisma.shopifyIntegration.deleteMany({ where: { company_id: id } }),
            this.prisma.user.deleteMany({ where: { company_id: id } }),
            this.prisma.company.delete({ where: { id } }),
        ]);
        return { message: 'Company deleted' };
    }
    async getPlans() {
        return (0, decimal_1.numifyDecimals)(await this.prisma.subscription.findMany({ orderBy: { id: 'asc' } }));
    }
    mapPlanData(input, partial) {
        const data = {};
        const num = (v) => (v === undefined || v === null ? undefined : Number(v));
        const str = (v) => v === undefined ? undefined : v === null ? null : String(v);
        const bool = (v) => (v === undefined ? undefined : !!v);
        const set = (k, v) => {
            if (v !== undefined)
                data[k] = v;
        };
        set('plan_name', str(input.plan_name));
        set('contact_limit', num(input.contact_limit));
        set('template_limit', num(input.template_limit));
        set('user_limit', num(input.user_limit));
        set('monthly_price', num(input.monthly_price));
        set('setup_fee', num(input.setup_fee));
        set('webhook_enabled', bool(input.webhook_enabled));
        set('ai_enabled', bool(input.ai_enabled));
        set('is_public', bool(input.is_public));
        set('display_order', num(input.display_order));
        set('is_highlighted', bool(input.is_highlighted));
        set('tagline', str(input.tagline));
        set('cta_label', str(input.cta_label));
        set('currency', str(input.currency));
        set('billing_period', str(input.billing_period));
        if (input.features !== undefined) {
            data.features = Array.isArray(input.features)
                ? input.features
                    .filter((f) => typeof f === 'string')
                    .map((f) => f.trim())
                    .filter((f) => f.length > 0)
                : [];
        }
        if (!partial && data.plan_name === undefined) {
            throw new common_1.BadRequestException('plan_name is required');
        }
        return data;
    }
    async createPlan(input) {
        const data = this.mapPlanData(input, false);
        const created = await this.prisma.subscription.create({ data: data });
        this.cache.del(public_service_1.PUBLIC_PRICING_CACHE_KEY);
        return (0, decimal_1.numifyDecimals)(created);
    }
    async updatePlan(id, input) {
        const data = this.mapPlanData(input, true);
        const updated = await this.prisma.subscription.update({
            where: { id },
            data: data,
        });
        this.cache.del(public_service_1.PUBLIC_PRICING_CACHE_KEY);
        return (0, decimal_1.numifyDecimals)(updated);
    }
    async getInvoices(page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const [items, total] = await Promise.all([
            this.prisma.invoice.findMany({
                skip,
                take: limit,
                include: { company: { select: { company_name: true } } },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.invoice.count(),
        ]);
        return (0, decimal_1.numifyDecimals)({ items, meta: { page, limit, total } });
    }
    async getUsage() {
        const period = new Date().toISOString().slice(0, 7);
        const [companies, contactGroups, templateGroups, usageRows] = await Promise.all([
            this.prisma.company.findMany({
                select: {
                    id: true,
                    company_name: true,
                    subscription: true,
                },
                orderBy: { company_name: 'asc' },
            }),
            this.prisma.contact.groupBy({
                by: ['company_id'],
                where: { deleted_at: null },
                _count: { _all: true },
            }),
            this.prisma.template.groupBy({
                by: ['company_id'],
                where: { deleted_at: null },
                _count: { _all: true },
            }),
            this.prisma.usageMetering.findMany({ where: { period } }),
        ]);
        const contactMap = new Map(contactGroups.map((g) => [g.company_id, g._count._all]));
        const templateMap = new Map(templateGroups.map((g) => [g.company_id, g._count._all]));
        const usageMap = new Map(usageRows.map((u) => [u.company_id, u]));
        const rows = companies.map((c) => {
            const u = usageMap.get(c.id);
            return {
                id: c.id,
                company_id: c.id,
                period,
                messages_sent: u?.messages_sent ?? 0,
                contacts_stored: contactMap.get(c.id) ?? 0,
                templates_used: templateMap.get(c.id) ?? 0,
                webhook_calls: u?.webhook_calls ?? 0,
                conversations_opened: u?.conversations_opened ?? 0,
                company: {
                    company_name: c.company_name,
                    subscription: c.subscription,
                },
            };
        });
        return (0, decimal_1.numifyDecimals)(rows);
    }
    async getAuditLogs(page = 1, limit = 50) {
        const skip = (page - 1) * limit;
        const [items, total] = await Promise.all([
            this.prisma.auditLog.findMany({
                skip,
                take: limit,
                include: { user: { select: { name: true, email: true } } },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.auditLog.count(),
        ]);
        return { items, meta: { page, limit, total } };
    }
    async impersonate(companyId, actingAdminId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            include: { users: { where: { role: 'owner' }, take: 1 } },
        });
        if (!company)
            throw new common_1.NotFoundException('Company not found');
        const owner = company.users[0];
        const payload = {
            sub: owner.id,
            companyId,
            role: owner.role,
            email: owner.email,
            impersonated: true,
        };
        await this.prisma.auditLog.create({
            data: {
                user_id: actingAdminId,
                company_id: null,
                action: 'super_admin.impersonate',
                entity: 'company',
                entity_id: companyId,
                metadata: { targetCompanyId: companyId },
            },
        }).catch((err) => this.logger.warn(`impersonate audit log failed (non-fatal): ${err.message}`));
        const token = this.jwt.sign(payload, {
            secret: this.config.get('JWT_SECRET'),
            expiresIn: '1h',
        });
        return { impersonationToken: token };
    }
};
exports.SuperAdminService = SuperAdminService;
exports.SuperAdminService = SuperAdminService = SuperAdminService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        jwt_1.JwtService,
        config_1.ConfigService,
        platform_setting_service_1.PlatformSettingService,
        limit_notifier_service_1.LimitNotifierService,
        cache_service_1.CacheService,
        company_status_service_1.CompanyStatusService,
        mail_service_1.MailService])
], SuperAdminService);
//# sourceMappingURL=super-admin.service.js.map