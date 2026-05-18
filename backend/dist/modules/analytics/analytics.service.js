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
exports.AnalyticsService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../../prisma/prisma.service");
const cache_service_1 = require("../../common/services/cache.service");
const CACHE_TTL_SEC = 300;
const MAX_RANGE_DAYS = 90;
const DEFAULT_RANGE_DAYS = 30;
function n(v) {
    if (typeof v === 'bigint')
        return Number(v);
    if (v === null || v === undefined)
        return 0;
    return Number(v);
}
let AnalyticsService = class AnalyticsService {
    constructor(prisma, cache, config) {
        this.prisma = prisma;
        this.cache = cache;
        this.config = config;
    }
    resolveRange(dto) {
        const to = dto.to ? new Date(dto.to) : new Date();
        const from = dto.from
            ? new Date(dto.from)
            : new Date(to.getTime() - DEFAULT_RANGE_DAYS * 86_400_000);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
            throw new common_1.BadRequestException('Invalid date range');
        }
        if (from.getTime() > to.getTime()) {
            throw new common_1.BadRequestException('`from` must be before `to`');
        }
        const spanDays = (to.getTime() - from.getTime()) / 86_400_000;
        if (spanDays > MAX_RANGE_DAYS) {
            throw new common_1.BadRequestException(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);
        }
        return { from, to };
    }
    async cached(companyId, route, paramHash, producer) {
        const key = `analytics:${companyId}:${route}:${paramHash}`;
        const hit = this.cache.get(key);
        if (hit !== undefined)
            return hit;
        const fresh = await producer();
        this.cache.set(key, fresh, CACHE_TTL_SEC);
        return fresh;
    }
    async overview(companyId) {
        return this.cached(companyId, 'overview', 'static', async () => {
            const monthStart = new Date().toISOString().slice(0, 7) + '-01';
            const [contacts] = await this.prisma.$queryRawUnsafe(`SELECT COUNT(*) c FROM contacts WHERE company_id = ? AND deleted_at IS NULL`, companyId);
            const [convos] = await this.prisma.$queryRawUnsafe(`SELECT
           SUM(status <> 'resolved') active,
           SUM(status = 'open') open
         FROM conversations WHERE company_id = ? AND deleted_at IS NULL`, companyId);
            const [msgs] = await this.prisma.$queryRawUnsafe(`SELECT
           SUM(created_at >= ?) this_month,
           SUM(direction = 'outbound') sent,
           SUM(direction = 'outbound' AND status IN ('delivered','read')) delivered,
           SUM(direction = 'outbound' AND status = 'read') \`read\`,
           SUM(direction = 'inbound') inbound
         FROM messages WHERE company_id = ?`, monthStart, companyId);
            const [bots] = await this.prisma.$queryRawUnsafe(`SELECT COUNT(*) c FROM audit_logs
         WHERE company_id = ? AND action = 'bot.executed'`, companyId);
            const sent = n(msgs?.sent);
            const delivered = n(msgs?.delivered);
            const read = n(msgs?.read);
            const inbound = n(msgs?.inbound);
            const botExec = n(bots?.c);
            const [conv] = await this.prisma.$queryRawUnsafe(`SELECT COUNT(*) out_convos, SUM(has_in) replied FROM (
           SELECT conversation_id, MAX(direction = 'inbound') has_in
           FROM messages WHERE company_id = ?
           GROUP BY conversation_id
           HAVING MAX(direction = 'outbound') = 1
         ) t`, companyId);
            const pct = (a, b) => b > 0
                ? Math.min(100, Math.max(0, Math.round((a / b) * 10000) / 100))
                : 0;
            return {
                totalContacts: n(contacts?.c),
                activeConversations: n(convos?.active),
                openChats: n(convos?.open),
                messagesThisMonth: n(msgs?.this_month),
                deliveryRate: pct(delivered, sent),
                readRate: pct(read, delivered),
                replyRate: pct(n(conv?.replied), n(conv?.out_convos)),
                botHandledPct: pct(botExec, inbound),
            };
        });
    }
    async funnel(companyId, dto) {
        const { from, to } = this.resolveRange(dto);
        return this.cached(companyId, 'funnel', `${from.toISOString()}_${to.toISOString()}`, async () => {
            const rows = await this.prisma.$queryRawUnsafe(`SELECT
             DATE(created_at) date,
             SUM(direction = 'outbound') sent,
             SUM(direction = 'outbound' AND status IN ('delivered','read')) delivered,
             SUM(direction = 'outbound' AND status = 'read') \`read\`,
             SUM(direction = 'inbound') replied
           FROM messages
           WHERE company_id = ? AND created_at >= ? AND created_at <= ?
           GROUP BY DATE(created_at)
           ORDER BY DATE(created_at)`, companyId, from, to);
            return rows.map((r) => ({
                date: r.date,
                sent: n(r.sent),
                delivered: n(r.delivered),
                read: n(r.read),
                replied: n(r.replied),
            }));
        });
    }
    async agents(companyId, dto) {
        const { from, to } = this.resolveRange(dto);
        return this.cached(companyId, 'agents', `${from.toISOString()}_${to.toISOString()}`, async () => {
            const rows = await this.prisma.$queryRawUnsafe(`SELECT
             u.id userId,
             u.name name,
             COUNT(DISTINCT c.id) conversationsHandled,
             AVG(TIMESTAMPDIFF(MINUTE, c.created_at, c.updated_at)) avgResponseTimeMin,
             COALESCE(SUM(m.direction = 'outbound'), 0) messagesSent
           FROM users u
           JOIN conversations c
             ON c.assigned_user_id = u.id AND c.company_id = ?
            AND c.created_at >= ? AND c.created_at <= ?
           LEFT JOIN messages m ON m.conversation_id = c.id
           WHERE u.company_id = ?
           GROUP BY u.id, u.name
           ORDER BY conversationsHandled DESC`, companyId, from, to, companyId);
            return rows.map((r) => ({
                userId: n(r.userId),
                name: r.name,
                conversationsHandled: n(r.conversationsHandled),
                avgResponseTimeMin: Math.round(n(r.avgResponseTimeMin) * 100) / 100,
                messagesSent: n(r.messagesSent),
            }));
        });
    }
    async broadcast(companyId, broadcastId) {
        return this.cached(companyId, 'broadcast', String(broadcastId), async () => {
            const b = await this.prisma.broadcast.findFirst({
                where: { id: broadcastId, company_id: companyId },
            });
            if (!b) {
                throw new common_1.BadRequestException('Broadcast not found');
            }
            const [reply] = await this.prisma.$queryRawUnsafe(`SELECT COUNT(*) c FROM messages
           WHERE company_id = ? AND direction = 'inbound'
             AND conversation_id IN (
               SELECT DISTINCT conversation_id FROM messages
               WHERE company_id = ? AND broadcast_id = ?
             )`, companyId, companyId, broadcastId);
            const byHour = await this.prisma.$queryRawUnsafe(`SELECT HOUR(created_at) hour, COUNT(*) c
           FROM messages
           WHERE company_id = ? AND broadcast_id = ?
             AND status IN ('delivered','read')
           GROUP BY HOUR(created_at) ORDER BY hour`, companyId, broadcastId);
            return {
                sent: b.sent_count,
                delivered: b.delivered_count,
                read: b.read_count,
                failed: b.failed_count,
                replyCount: n(reply?.c),
                deliveryByHour: byHour.map((r) => ({
                    hour: n(r.hour),
                    count: n(r.c),
                })),
            };
        });
    }
    async conversationCost(companyId, dto) {
        const { from, to } = this.resolveRange(dto);
        return this.cached(companyId, 'conversation-cost', `${from.toISOString()}_${to.toISOString()}`, async () => {
            const [row] = await this.prisma.$queryRawUnsafe(`SELECT COUNT(*) c FROM (
             SELECT c.contact_id, DATE(m.created_at) d
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
             WHERE m.company_id = ? AND m.created_at >= ? AND m.created_at <= ?
             GROUP BY c.contact_id, DATE(m.created_at)
           ) grp`, companyId, from, to);
            const totalConversations = n(row?.c);
            const rateUsed = Number(this.config.get('META_CONVERSATION_FLAT_USD') ?? 0.005);
            return {
                totalConversations,
                estimatedCostUSD: Math.round(totalConversations * rateUsed * 10000) / 10000,
                rateUsed,
                note: 'Placeholder flat-rate estimate — not Meta-billed pricing. Distinct (company, contact, day) buckets.',
            };
        });
    }
    async usage(companyId) {
        const period = new Date().toISOString().slice(0, 7);
        const [usage, company] = await Promise.all([
            this.prisma.usageMetering.findUnique({
                where: { company_id_period: { company_id: companyId, period } },
            }),
            this.prisma.company.findUnique({
                where: { id: companyId },
                include: { subscription: true },
            }),
        ]);
        const sub = company?.subscription;
        return {
            period,
            usage: {
                messagesSent: usage?.messages_sent ?? 0,
                contactsStored: usage?.contacts_stored ?? 0,
                templatesUsed: usage?.templates_used ?? 0,
                webhookCalls: usage?.webhook_calls ?? 0,
                conversationsOpened: usage?.conversations_opened ?? 0,
            },
            limits: sub
                ? {
                    contactLimit: sub.contact_limit,
                    templateLimit: sub.template_limit,
                    userLimit: sub.user_limit,
                }
                : null,
        };
    }
};
exports.AnalyticsService = AnalyticsService;
exports.AnalyticsService = AnalyticsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        cache_service_1.CacheService,
        config_1.ConfigService])
], AnalyticsService);
//# sourceMappingURL=analytics.service.js.map