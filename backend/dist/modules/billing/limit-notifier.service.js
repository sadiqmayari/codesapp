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
var LimitNotifierService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.LimitNotifierService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
const cache_service_1 = require("../../common/services/cache.service");
const mail_service_1 = require("../../common/services/mail.service");
const webhook_dispatcher_service_1 = require("../webhooks/webhook-dispatcher.service");
const inbox_gateway_1 = require("../inbox/inbox.gateway");
const effective_limits_1 = require("../../common/utils/effective-limits");
const THRESHOLDS = [
    { pct: 90, key: '90' },
    { pct: 99, key: '99' },
    { pct: 100, key: '100' },
];
const DIM_MAP = {
    contacts: 'contacts',
    contacts_stored: 'contacts',
    templates: 'templates',
    templates_used: 'templates',
};
let LimitNotifierService = LimitNotifierService_1 = class LimitNotifierService {
    constructor(prisma, cache, mail, dispatcher, gateway) {
        this.prisma = prisma;
        this.cache = cache;
        this.mail = mail;
        this.dispatcher = dispatcher;
        this.gateway = gateway;
        this.logger = new common_1.Logger(LimitNotifierService_1.name);
    }
    async evaluate(companyId, rawDim) {
        const dim = DIM_MAP[rawDim];
        if (!dim)
            return;
        try {
            const period = new Date().toISOString().slice(0, 7);
            const company = await this.prisma.company.findUnique({
                where: { id: companyId },
                select: {
                    company_name: true,
                    contact_limit_override: true,
                    template_limit_override: true,
                    user_limit_override: true,
                    subscription: {
                        select: {
                            contact_limit: true,
                            template_limit: true,
                            user_limit: true,
                        },
                    },
                    users: {
                        where: { role: 'owner' },
                        select: { name: true, email: true },
                        take: 1,
                    },
                },
            });
            if (!company?.subscription)
                return;
            const limits = (0, effective_limits_1.resolveEffectiveLimits)(company.subscription, company);
            const limit = dim === 'contacts' ? limits.contact_limit : limits.template_limit;
            if (!limit || limit <= 0)
                return;
            const usage = await this.prisma.usageMetering.findUnique({
                where: { company_id_period: { company_id: companyId, period } },
            });
            if (!usage)
                return;
            const current = dim === 'contacts'
                ? usage.contacts_stored
                : usage.templates_used;
            const pct = (current / limit) * 100;
            const notified = parseLedger(usage.thresholds_notified);
            const owner = company.users[0]
                ? {
                    email: company.users[0].email,
                    name: company.users[0].name,
                    companyName: company.company_name,
                }
                : null;
            for (const t of THRESHOLDS) {
                if (pct < t.pct)
                    continue;
                const flag = `${dim}:${t.key}`;
                if (notified.has(flag))
                    continue;
                const persisted = await this.markFlag(usage.id, notified, flag);
                if (!persisted)
                    continue;
                await this.fireOne(companyId, dim, t.key, current, limit, period, owner);
            }
        }
        catch (err) {
            this.logger.warn(`limit-notifier evaluate(${companyId}, ${rawDim}) failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    async markFlag(usageRowId, inMemory, flag) {
        if (inMemory.has(flag))
            return false;
        const next = [...inMemory, flag];
        inMemory.add(flag);
        const result = await this.prisma.usageMetering.updateMany({
            where: {
                id: usageRowId,
                AND: [
                    {
                        OR: [
                            { thresholds_notified: { equals: client_1.Prisma.JsonNull } },
                            { thresholds_notified: { not: { array_contains: flag } } },
                        ],
                    },
                ],
            },
            data: { thresholds_notified: next },
        });
        return result.count > 0;
    }
    async fireOne(companyId, dim, threshold, current, limit, period, owner) {
        const pct = Math.round((current / limit) * 100);
        const severity = threshold === '90' ? 'warn' : 'critical';
        this.gateway.emitToCompany(companyId, 'usage.warning', {
            dim,
            threshold,
            pct,
            current,
            limit,
            severity,
            period,
        });
        if (owner) {
            await this.mail.send(owner.email, usageEmailSubject(dim, threshold, owner.companyName), usageEmailHtml(owner.name, owner.companyName, dim, threshold, current, limit));
        }
        const event = threshold === '100'
            ? 'subscription.limit.reached'
            : 'subscription.limit.warning';
        await this.dispatcher.dispatch(companyId, event, {
            dimension: dim,
            threshold: Number(threshold),
            current,
            limit,
            period,
        });
        this.logger.log(`usage notification fired: company=${companyId} dim=${dim} threshold=${threshold} (${current}/${limit})`);
    }
    async snapshot(companyId) {
        const period = new Date().toISOString().slice(0, 7);
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            select: {
                contact_limit_override: true,
                template_limit_override: true,
                user_limit_override: true,
                subscription: {
                    select: {
                        contact_limit: true,
                        template_limit: true,
                        user_limit: true,
                    },
                },
            },
        });
        if (!company?.subscription)
            return [];
        const usage = await this.prisma.usageMetering.findUnique({
            where: { company_id_period: { company_id: companyId, period } },
        });
        if (!usage)
            return [];
        const limits = (0, effective_limits_1.resolveEffectiveLimits)(company.subscription, company);
        const out = [];
        const evalDim = (dim, current, limit) => {
            if (limit <= 0)
                return;
            const pct = (current / limit) * 100;
            const top = pct >= 100
                ? { pct: 100, key: '100' }
                : pct >= 99
                    ? { pct: 99, key: '99' }
                    : pct >= 90
                        ? { pct: 90, key: '90' }
                        : null;
            if (!top)
                return;
            out.push({
                dim,
                threshold: top.key,
                pct: Math.min(100, Math.round(pct)),
                current,
                limit,
                severity: top.key === '90' ? 'warn' : 'critical',
            });
        };
        evalDim('contacts', usage.contacts_stored, limits.contact_limit);
        evalDim('templates', usage.templates_used, limits.template_limit);
        return out;
    }
    async sendSuspensionEmail(companyId) {
        try {
            const company = await this.prisma.company.findUnique({
                where: { id: companyId },
                select: {
                    company_name: true,
                    users: {
                        where: { role: 'owner' },
                        select: { name: true, email: true },
                        take: 1,
                    },
                    invoices: {
                        where: { status: { in: ['pending', 'overdue'] } },
                        select: { amount: true },
                    },
                },
            });
            const owner = company?.users[0];
            if (!owner)
                return;
            const outstanding = (company.invoices ?? []).reduce((s, i) => s + Number(i.amount), 0);
            await this.mail.send(owner.email, `[CodesApp] Your account has been suspended`, suspensionEmailHtml(owner.name, company.company_name, outstanding));
        }
        catch (err) {
            this.logger.warn(`suspension email failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
};
exports.LimitNotifierService = LimitNotifierService;
exports.LimitNotifierService = LimitNotifierService = LimitNotifierService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        cache_service_1.CacheService,
        mail_service_1.MailService,
        webhook_dispatcher_service_1.WebhookDispatcherService,
        inbox_gateway_1.InboxGateway])
], LimitNotifierService);
function parseLedger(raw) {
    if (!Array.isArray(raw))
        return new Set();
    return new Set(raw.filter((v) => typeof v === 'string'));
}
const DIM_LABEL = {
    contacts: 'contacts',
    templates: 'message templates',
};
function usageEmailSubject(dim, threshold, companyName) {
    const label = DIM_LABEL[dim];
    if (threshold === '100')
        return `[CodesApp] ${companyName} — ${label} quota reached`;
    return `[CodesApp] ${companyName} — ${threshold}% of ${label} quota used`;
}
function usageEmailHtml(ownerName, companyName, dim, threshold, current, limit) {
    const label = DIM_LABEL[dim];
    const banner = threshold === '100'
        ? `<p style="background:#fef2f2;color:#991b1b;border:1px solid #fecaca;padding:10px 14px;border-radius:8px;font-weight:600;">You have reached your ${label} quota. New ${label} may be blocked depending on your usage-limit policy.</p>`
        : threshold === '99'
            ? `<p style="background:#fef2f2;color:#991b1b;border:1px solid #fecaca;padding:10px 14px;border-radius:8px;font-weight:600;">Critical: 99% of your ${label} quota used. Service will be restricted at 100%.</p>`
            : `<p style="background:#fffbeb;color:#92400e;border:1px solid #fde68a;padding:10px 14px;border-radius:8px;font-weight:600;">You've used 90% of your ${label} quota. Consider upgrading before you hit the cap.</p>`;
    return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;color:#111827;">
      <h2 style="margin:0 0 6px;">Hi ${escapeHtml(ownerName)},</h2>
      <p style="margin:0 0 14px;color:#4b5563;">
        Your CodesApp workspace <strong>${escapeHtml(companyName)}</strong> is approaching a plan limit.
      </p>
      ${banner}
      <table style="border-collapse:collapse;margin-top:14px;font-size:14px;">
        <tr><td style="color:#6b7280;padding:4px 12px 4px 0;">Dimension</td><td style="font-weight:600;">${label}</td></tr>
        <tr><td style="color:#6b7280;padding:4px 12px 4px 0;">Used</td><td style="font-weight:600;">${current.toLocaleString()} / ${limit.toLocaleString()}</td></tr>
      </table>
      <p style="margin-top:18px;">
        <a href="https://apps.codentra.pk/billing" style="background:#16a34a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">View usage</a>
      </p>
      <p style="margin-top:18px;font-size:12px;color:#9ca3af;">
        Need help? Email admin@codentra.pk
      </p>
    </div>
  `;
}
function suspensionEmailHtml(ownerName, companyName, outstandingUsd) {
    return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;color:#111827;">
      <h2 style="margin:0 0 6px;">Hi ${escapeHtml(ownerName)},</h2>
      <p style="margin:0 0 14px;color:#4b5563;">
        Your CodesApp workspace <strong>${escapeHtml(companyName)}</strong> has been
        <strong style="color:#dc2626;">suspended</strong>.
      </p>
      <p style="background:#fef2f2;color:#991b1b;border:1px solid #fecaca;padding:10px 14px;border-radius:8px;">
        While suspended, sign-in to the app is disabled. Inbound WhatsApp
        messages are still recorded against your account and will be visible
        once service is restored.
      </p>
      <table style="border-collapse:collapse;margin-top:14px;font-size:14px;">
        <tr><td style="color:#6b7280;padding:4px 12px 4px 0;">Outstanding balance</td><td style="font-weight:600;">$${outstandingUsd.toFixed(2)}</td></tr>
      </table>
      <p style="margin-top:18px;">
        To restore service, please settle the outstanding balance with our team at
        <a href="mailto:admin@codentra.pk">admin@codentra.pk</a>.
      </p>
    </div>
  `;
}
function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => c === '&'
        ? '&amp;'
        : c === '<'
            ? '&lt;'
            : c === '>'
                ? '&gt;'
                : c === '"'
                    ? '&quot;'
                    : '&#39;');
}
//# sourceMappingURL=limit-notifier.service.js.map