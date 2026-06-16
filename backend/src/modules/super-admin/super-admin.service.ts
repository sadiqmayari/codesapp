import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { numifyDecimals } from '../../common/utils/decimal';
import {
  PlatformSettingService,
  UsageLimitAction,
} from '../../common/services/platform-setting.service';
import {
  ENGAGEMENT_ENGINE_COMPANY_IDS_KEY,
  ENGAGEMENT_ENGINE_MODE_KEY,
} from '../ai/ai.constants';
import { LimitNotifierService } from '../billing/limit-notifier.service';
import { CompanyStatusService } from '../../common/services/company-status.service';
import { MailService } from '../../common/services/mail.service';
import { PUBLIC_PRICING_CACHE_KEY } from '../public/public.service';

/** Safe BigInt → number for COUNT/SUM aggregates from $queryRawUnsafe. */
function n(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (v === null || v === undefined) return 0;
  return Number(v);
}

@Injectable()
export class SuperAdminService {
  private readonly logger = new Logger(SuperAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly platformSetting: PlatformSettingService,
    private readonly limitNotifier: LimitNotifierService,
    private readonly cache: CacheService,
    private readonly companyStatus: CompanyStatusService,
    private readonly mail: MailService,
  ) {}

  async getSettings() {
    return {
      usageLimitAction: await this.platformSetting.getUsageLimitAction(),
      aiProvider: await this.platformSetting.get('ai_provider', 'anthropic'),
      aiAutonomousTier: await this.platformSetting.getAutonomousTier(),
      // Engagement engine (conversation/AI redesign) rollout controls.
      engagementCompanyIds: await this.platformSetting.get(
        ENGAGEMENT_ENGINE_COMPANY_IDS_KEY,
        '',
      ),
      engagementMode: await this.platformSetting.get(
        ENGAGEMENT_ENGINE_MODE_KEY,
        'shadow',
      ),
    };
  }

  async updateSettings(
    usageLimitAction: UsageLimitAction,
    aiProvider?: 'anthropic' | 'openai',
    aiAutonomousTier?: 'fast' | 'smart',
    engagementCompanyIds?: string,
    engagementMode?: 'shadow' | 'on',
  ) {
    await this.platformSetting.setUsageLimitAction(usageLimitAction);
    if (aiProvider) {
      await this.platformSetting.set('ai_provider', aiProvider);
    }
    if (aiAutonomousTier) {
      await this.platformSetting.setAutonomousTier(aiAutonomousTier);
    }
    // '' (empty) is a valid value (= OFF everywhere), so check for undefined.
    if (engagementCompanyIds !== undefined) {
      await this.platformSetting.set(
        ENGAGEMENT_ENGINE_COMPANY_IDS_KEY,
        engagementCompanyIds.trim(),
      );
    }
    if (engagementMode) {
      await this.platformSetting.set(ENGAGEMENT_ENGINE_MODE_KEY, engagementMode);
    }
    return {
      usageLimitAction,
      aiProvider: await this.platformSetting.get('ai_provider', 'anthropic'),
      aiAutonomousTier: await this.platformSetting.getAutonomousTier(),
      engagementCompanyIds: await this.platformSetting.get(
        ENGAGEMENT_ENGINE_COMPANY_IDS_KEY,
        '',
      ),
      engagementMode: await this.platformSetting.get(
        ENGAGEMENT_ENGINE_MODE_KEY,
        'shadow',
      ),
    };
  }

  async login(email: string, password: string, res: any) {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || user.role !== 'super_admin') {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

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

  /**
   * Rehydrate a super-admin session from the httpOnly sa_refresh_token
   * cookie so a page reload / revisit doesn't force re-login (the access
   * token lives only in JS memory).
   */
  async refresh(refreshToken: string | undefined, res: any) {
    if (!refreshToken) throw new UnauthorizedException('No session');
    let payload: any;
    try {
      payload = this.jwt.verify(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid session');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || user.role !== 'super_admin') {
      throw new UnauthorizedException('Invalid session');
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

  /** Clear the super-admin refresh cookie so logout actually ends the session. */
  logout(res: any) {
    res.clearCookie('sa_refresh_token', {
      httpOnly: true,
      secure: this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      path: '/',
    });
    return { message: 'Logged out' };
  }

  /**
   * Comprehensive super-admin dashboard payload — KPIs (counts + MRR + this-
   * month invoiced/paid + outstanding), 90-day signups trend, pending-
   * approvals widget, overdue-invoices widget, recent activity feed. Single
   * call, parallelized; all derived from existing tables (no schema change).
   */
  async getDashboard() {
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const dayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);

    type Counts = { active: bigint; pending: bigint; suspended: bigint };
    type Money = { v: any };

    const [
      counts,
      totalUsers,
      mrr,
      invoicedThisMonth,
      paidThisMonth,
      outstanding,
      newSignups,
      activeConvosToday,
      signups90d,
      pendingApprovals,
      overdueInvoices,
      recentActivity,
    ] = await Promise.all([
      this.prisma.$queryRawUnsafe<Counts[]>(
        `SELECT
           SUM(activation_status='active') active,
           SUM(activation_status='pending') pending,
           SUM(activation_status='suspended') suspended
         FROM companies`,
      ),
      this.prisma.user.count({ where: { role: { not: 'super_admin' } } }),
      // MRR: sum of monthly_price for active companies (the only ones being
      // billed). Decimal returned as string — sanitized below.
      this.prisma.$queryRawUnsafe<Money[]>(
        `SELECT COALESCE(SUM(s.monthly_price), 0) v
         FROM companies c JOIN subscriptions s ON s.id = c.subscription_id
         WHERE c.activation_status = 'active'`,
      ),
      this.prisma.$queryRawUnsafe<Money[]>(
        `SELECT COALESCE(SUM(amount), 0) v FROM invoices
         WHERE created_at >= ?`,
        monthStart,
      ),
      this.prisma.$queryRawUnsafe<Money[]>(
        `SELECT COALESCE(SUM(amount), 0) v FROM invoices
         WHERE paid_at IS NOT NULL AND paid_at >= ?`,
        monthStart,
      ),
      this.prisma.$queryRawUnsafe<Money[]>(
        `SELECT COALESCE(SUM(amount), 0) v FROM invoices
         WHERE status IN ('pending','overdue')`,
      ),
      this.prisma.company.count({
        where: { created_at: { gte: monthStart } },
      }),
      // "Active conversations today" — counted from `conversations`
      // (last_message_at is maintained on every inbound/outbound message),
      // NOT by scanning the whole `messages` table. `messages` has no index on
      // `created_at`, so `... FROM messages WHERE created_at >= ?` was a FULL
      // TABLE SCAN that, under connection_limit=1 + pool_timeout=0, held the
      // single DB connection and hung the dashboard as the table grew.
      this.prisma.conversation.count({
        where: { deleted_at: null, last_message_at: { gte: dayStart } },
      }),
      // Signups per day for the trend chart. Backfilled to zero on the FE.
      this.prisma.$queryRawUnsafe<{ d: string; c: bigint }[]>(
        `SELECT DATE(created_at) d, COUNT(*) c
         FROM companies
         WHERE created_at >= ?
         GROUP BY DATE(created_at)
         ORDER BY d`,
        ninetyDaysAgo,
      ),
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
      this.prisma.$queryRawUnsafe<
        {
          id: number;
          invoice_number: string | null;
          company_id: number;
          company_name: string;
          amount: any;
          due_date: Date;
          days_overdue: number;
        }[]
      >(
        `SELECT i.id, i.invoice_number, i.company_id, c.company_name,
                i.amount, i.due_date,
                GREATEST(0, DATEDIFF(NOW(), i.due_date)) days_overdue
         FROM invoices i JOIN companies c ON c.id = i.company_id
         WHERE i.status IN ('pending','overdue') AND i.due_date < NOW()
         ORDER BY i.due_date ASC
         LIMIT 5`,
      ),
      this.prisma.auditLog.findMany({
        orderBy: { created_at: 'desc' },
        take: 10,
        include: {
          user: { select: { name: true, email: true } },
        },
      }),
    ]);

    const dec = (rows: Money[]) =>
      Math.round(Number(rows?.[0]?.v ?? 0) * 100) / 100;

    return numifyDecimals({
      kpis: {
        totalClients:
          n(counts[0]?.active) +
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

    return numifyDecimals({ items, meta: { page, limit, total } });
  }

  async getClient(id: number) {
    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        subscription: true,
        users: { select: { id: true, name: true, email: true, role: true, status: true } },
      },
    });
    if (!company) throw new NotFoundException('Company not found');
    return numifyDecimals(company);
  }

  /**
   * Expanded client profile payload — everything the new
   * /super-admin/clients/[id] page needs in a SINGLE call.
   * Sibling of getClient (kept intact for backward compat).
   */
  async getClientDetail(id: number) {
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
    if (!company) throw new NotFoundException('Company not found');

    const period = new Date().toISOString().slice(0, 7);

    const [
      activeContacts,
      totalContacts,
      templatesCount,
      activeUsersCount,
      openInvoicesAgg,
      windowOpenChats,
      messagesThisMonthAgg,
      conversationsThisMonthCount,
      usage,
      invoices,
      shopify,
      audit,
    ] = await Promise.all([
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
    const mrrUsd =
      company.activation_status === 'active' ? monthlyPrice : 0;

    // Resolve the EFFECTIVE usage-limit-action (per-company override
    // takes precedence over platform default; mirrors PlanGuard).
    const effectiveUsageLimitAction =
      company.usage_limit_action ??
      (await this.platformSetting.getUsageLimitAction());

    return numifyDecimals({
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
        // Phase 4: per-client limit overrides + the resolved effective caps
        // (override ?? subscription default). Frontend shows the override
        // value as editable; falls back to the plan default when null.
        contact_limit_override: company.contact_limit_override,
        template_limit_override: company.template_limit_override,
        user_limit_override: company.user_limit_override,
        effective_limits: company.subscription
          ? {
              contact_limit:
                company.contact_limit_override ??
                company.subscription.contact_limit,
              template_limit:
                company.template_limit_override ??
                company.subscription.template_limit,
              user_limit:
                company.user_limit_override ??
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
        // AI capabilities. premium_locked is the super-admin kill-switch; the
        // rest are the tenant's own choices, shown read-only so the admin sees
        // what locking will override.
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
      // The client-profile "Plan & limits" bars read usage.contacts_stored /
      // templates_used. Those must be the LIVE stored totals (cumulative vs
      // the cap), NOT the per-month usage_metering counters (which reset each
      // calendar month). Reuse the live counts already computed above.
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

  async activateClient(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.company.findUnique({
        where: { id },
        select: { activated_at: true },
      });

      const company = await tx.company.update({
        where: { id },
        data: {
          activation_status: 'active',
          // Anchor the 30-day billing cycle on the FIRST activation only;
          // reactivations must not move it (cycle would drift).
          ...(existing?.activated_at ? {} : { activated_at: new Date() }),
          suspended_at: null,
        },
      });

      // Activate the owner user
      await tx.user.updateMany({
        where: { company_id: id, role: 'owner' },
        data: { status: 'active' },
      });

      return company;
    }).then((company) => {
      this.companyStatus.invalidate(id); // resume outbound immediately
      return company;
    });
  }

  async suspendClient(id: number) {
    const before = await this.prisma.company.findUnique({
      where: { id },
      select: { activation_status: true },
    });
    const updated = await this.prisma.company.update({
      where: { id },
      data: { activation_status: 'suspended', suspended_at: new Date() },
    });
    // Fire the suspension notice email only on a non-suspended → suspended
    // transition (don't re-spam if the super-admin clicks twice).
    if (before?.activation_status !== 'suspended') {
      this.limitNotifier.sendSuspensionEmail(id).catch(() => undefined);
    }
    this.companyStatus.invalidate(id); // pause outbound immediately
    return updated;
  }

  /**
   * Phase 4: persist per-client limit overrides. Each field is optional;
   * passing `null` clears the override (falls back to subscription default).
   * Invalidates the cached subscription so PlanGuard picks up the new caps
   * on the next request without waiting for the 5-minute TTL.
   */
  async setLimitOverrides(
    id: number,
    body: {
      contact_limit?: number | null;
      template_limit?: number | null;
      user_limit?: number | null;
    },
  ) {
    const company = await this.prisma.company.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!company) throw new NotFoundException('Company not found');

    const norm = (v: number | null | undefined): number | null => {
      if (v === null) return null;
      if (v === undefined) return undefined as unknown as null; // keep
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new BadRequestException('Limit override must be >= 0');
      }
      return Math.floor(n);
    };

    const data: Record<string, number | null> = {};
    if ('contact_limit' in body) {
      const v = norm(body.contact_limit ?? null);
      if (v !== (undefined as unknown as null))
        data.contact_limit_override = v;
    }
    if ('template_limit' in body) {
      const v = norm(body.template_limit ?? null);
      if (v !== (undefined as unknown as null))
        data.template_limit_override = v;
    }
    if ('user_limit' in body) {
      const v = norm(body.user_limit ?? null);
      if (v !== (undefined as unknown as null))
        data.user_limit_override = v;
    }

    const updated = await this.prisma.company.update({
      where: { id },
      data,
    });
    // Invalidate cached effective subscription so PlanGuard sees new caps now.
    this.cache.del(this.cache.subscriptionKey(id));
    return updated;
  }

  /**
   * Grant a delinquent company extra time: the auto-suspend cron skips it
   * while `grace_until` is in the future. Passing null clears the grace.
   * If the company is currently auto-suspended, granting future grace also
   * reactivates it so the owner regains access during the extension.
   */
  async grantGrace(id: number, until: Date | null) {
    const company = await this.prisma.company.findUnique({
      where: { id },
      select: { activation_status: true, suspended_at: true },
    });
    if (!company) throw new NotFoundException('Company not found');

    const reactivate =
      until !== null &&
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
    if (reactivate) this.companyStatus.invalidate(id);
    return updated;
  }

  // ── Plan-change / upgrade requests (super-admin review) ───────────────

  /** List plan-change requests (newest first), with company + plan names. */
  async listPlanRequests(status?: string) {
    const rows = await this.prisma.planChangeRequest.findMany({
      where: status ? { status } : {},
      orderBy: { id: 'desc' },
      take: 200,
      include: { company: { select: { id: true, company_name: true } } },
    });
    // Resolve plan names in one round-trip.
    const subIds = Array.from(
      new Set(
        rows
          .flatMap((r) => [r.requested_subscription_id, r.current_subscription_id])
          .filter((x): x is number => typeof x === 'number'),
      ),
    );
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

  /**
   * Resolve a plan-change request. `approve` switches the company to the
   * requested plan (when one was specified) and invalidates the cached
   * subscription so PlanGuard/billing pick it up; `reject` just records it.
   * Emails the company owner either way (best-effort).
   */
  async resolvePlanRequest(
    id: number,
    action: 'approve' | 'reject',
    note?: string,
  ) {
    const req = await this.prisma.planChangeRequest.findUnique({
      where: { id },
    });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'pending') {
      throw new BadRequestException('Request is already resolved.');
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

    // Notify the company owner (best-effort).
    const owner = await this.prisma.user.findFirst({
      where: { company_id: req.company_id, role: 'owner' },
      select: { email: true },
    });
    if (owner?.email) {
      void this.mail.send(
        owner.email,
        `Your plan-change request was ${updated.status}`,
        `<p>Your plan-change request has been <strong>${updated.status}</strong>.</p>` +
          (note ? `<p>${note}</p>` : '') +
          `<p>You can review your plan in Billing.</p>`,
      );
    }
    return updated;
  }

  /** Per-company override for usage-limit behavior. null → platform default. */
  async setUsageLimitAction(
    id: number,
    action: 'block' | 'warn_only' | null,
  ) {
    return this.prisma.company.update({
      where: { id },
      data: { usage_limit_action: action },
    });
  }

  /**
   * Per-tenant premium-AI kill-switch. Vision/voice/tier are now TENANT-owned
   * (Settings → AI); the super-admin keeps only this surgical override. When
   * `premiumLocked` is true the tenant is forced back to baseline (Standard
   * tier, no vision, no voice) — resolved in common/utils/ai-capabilities.ts —
   * regardless of what they selected. Used for abuse / non-payment.
   */
  async setAiCapabilities(id: number, caps: { premiumLocked?: boolean }) {
    const company = await this.prisma.company.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!company) throw new NotFoundException('Company not found');

    const data: { ai_premium_locked?: boolean } = {};
    if (caps.premiumLocked !== undefined) {
      data.ai_premium_locked = caps.premiumLocked;
    }

    const updated = await this.prisma.company.update({
      where: { id },
      data,
      select: { ai_premium_locked: true },
    });
    // PlanGuard caches the subscription; AI gate reads the company row live, but
    // bust the sub cache to be consistent with the other per-company overrides.
    this.cache.del(this.cache.subscriptionKey(id));
    return updated;
  }

  /**
   * Create a one-off invoice against a client. Distinct from the
   * activation-anchored 30-day cycle (which is `generateDueInvoices` owned).
   * Invoice number is namespaced `INV-{companyId}-OFF-{yymmdd-hhmmss}` so it
   * never collides with the cycle invoices `INV-{companyId}-{cycleStartYYYYMMDD}`.
   * Status starts `pending`; due_date defaults to issue + 7d like the cycle.
   */
  async createOneOffInvoice(
    companyId: number,
    data: {
      amount: number;
      description?: string | null;
      dueDate?: string | null;
    },
  ) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true },
    });
    if (!company) throw new NotFoundException('Company not found');

    const amt = Number(data.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      throw new BadRequestException('Amount must be > 0');
    }

    const now = new Date();
    const ts =
      now.toISOString().slice(2, 10).replace(/-/g, '') +
      '-' +
      now.toISOString().slice(11, 19).replace(/:/g, '');
    const invoiceNumber = `INV-${companyId}-OFF-${ts}`;

    const due =
      data.dueDate && data.dueDate.length > 0
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

    return numifyDecimals(created);
  }

  async deleteClient(id: number) {
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Company not found');

    // Cascade via Prisma relations — order matters due to FKs
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
    return numifyDecimals(
      await this.prisma.subscription.findMany({ orderBy: { id: 'asc' } }),
    );
  }

  /**
   * Whitelist the editable plan fields (the controller passes `@Body() any`, so
   * the service is the mass-assignment boundary). Includes the public
   * pricing-card fields. Used by both create + update.
   */
  private mapPlanData(input: Record<string, unknown>, partial: boolean) {
    const data: Record<string, unknown> = {};
    const num = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));
    const str = (v: unknown) =>
      v === undefined ? undefined : v === null ? null : String(v);
    const bool = (v: unknown) => (v === undefined ? undefined : !!v);

    const set = (k: string, v: unknown) => {
      if (v !== undefined) data[k] = v;
    };

    set('plan_name', str(input.plan_name));
    set('contact_limit', num(input.contact_limit));
    set('template_limit', num(input.template_limit));
    set('user_limit', num(input.user_limit));
    set('monthly_price', num(input.monthly_price));
    set('setup_fee', num(input.setup_fee));
    set('webhook_enabled', bool(input.webhook_enabled));
    set('ai_enabled', bool(input.ai_enabled));
    set('proactive_notifications', bool(input.proactive_notifications));
    // Public pricing-card fields
    set('is_public', bool(input.is_public));
    set('display_order', num(input.display_order));
    set('is_highlighted', bool(input.is_highlighted));
    set('tagline', str(input.tagline));
    set('cta_label', str(input.cta_label));
    set('currency', str(input.currency));
    set('billing_period', str(input.billing_period));
    if (input.features !== undefined) {
      data.features = Array.isArray(input.features)
        ? (input.features as unknown[])
            .filter((f): f is string => typeof f === 'string')
            .map((f) => f.trim())
            .filter((f) => f.length > 0)
        : [];
    }

    if (!partial && data.plan_name === undefined) {
      throw new BadRequestException('plan_name is required');
    }
    return data;
  }

  async createPlan(input: Record<string, unknown>) {
    const data = this.mapPlanData(input, false);
    const created = await this.prisma.subscription.create({ data: data as any });
    this.cache.del(PUBLIC_PRICING_CACHE_KEY);
    return numifyDecimals(created);
  }

  async updatePlan(id: number, input: Record<string, unknown>) {
    const data = this.mapPlanData(input, true);
    const updated = await this.prisma.subscription.update({
      where: { id },
      data: data as any,
    });
    this.cache.del(PUBLIC_PRICING_CACHE_KEY);
    return numifyDecimals(updated);
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
    return numifyDecimals({ items, meta: { page, limit, total } });
  }

  async getUsage() {
    const period = new Date().toISOString().slice(0, 7);

    // Company-driven (NOT usage_metering-driven) so that:
    //  (a) contacts/templates show LIVE cumulative totals — the per-month
    //      counters reset each calendar month and showed e.g. "8" for a tenant
    //      that actually stores 2,399 contacts;
    //  (b) tenants with NO activity in the current month still appear (a
    //      usage_metering row only exists once something is metered this month).
    // messages/webhooks/conversations remain this-month consumption counters.
    const [companies, contactGroups, templateGroups, usageRows] =
      await Promise.all([
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

    const contactMap = new Map(
      contactGroups.map((g) => [g.company_id, g._count._all]),
    );
    const templateMap = new Map(
      templateGroups.map((g) => [g.company_id, g._count._all]),
    );
    const usageMap = new Map(usageRows.map((u) => [u.company_id, u]));

    const rows = companies.map((c) => {
      const u = usageMap.get(c.id);
      return {
        // company id is unique per row → safe stable React key
        id: c.id,
        company_id: c.id,
        period,
        messages_sent: u?.messages_sent ?? 0,
        contacts_stored: contactMap.get(c.id) ?? 0, // LIVE cumulative
        templates_used: templateMap.get(c.id) ?? 0, // LIVE cumulative
        webhook_calls: u?.webhook_calls ?? 0,
        conversations_opened: u?.conversations_opened ?? 0,
        company: {
          company_name: c.company_name,
          subscription: c.subscription,
        },
      };
    });

    return numifyDecimals(rows);
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

  async impersonate(companyId: number, actingAdminId: number) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: { users: { where: { role: 'owner' }, take: 1 } },
    });
    if (!company) throw new NotFoundException('Company not found');

    const owner = company.users[0];
    const payload = {
      sub: owner.id,
      companyId,
      role: owner.role,
      email: owner.email,
      impersonated: true,
    };

    // Audit log — best-effort (user_id FK may fail if schema not yet migrated)
    await this.prisma.auditLog.create({
      data: {
        user_id: actingAdminId,
        company_id: null,
        action: 'super_admin.impersonate',
        entity: 'company',
        entity_id: companyId,
        metadata: { targetCompanyId: companyId },
      },
    }).catch((err: Error) =>
      this.logger.warn(`impersonate audit log failed (non-fatal): ${err.message}`),
    );

    const token = this.jwt.sign(payload, {
      secret: this.config.get('JWT_SECRET'),
      expiresIn: '1h',
    });

    return { impersonationToken: token };
  }
}
