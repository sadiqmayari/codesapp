import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InvoiceGeneratorService } from './invoice-generator.service';
import { LimitNotifierService } from './limit-notifier.service';
import { AiMeteringService } from '../ai/ai-metering.service';
import { ListInvoicesDto } from './dtos/list-invoices.dto';
import { RequestPlanChangeDto } from './dtos/request-plan-change.dto';
import { numifyDecimals } from '../../common/utils/decimal';
import { CompanyStatusService } from '../../common/services/company-status.service';
import { MailService } from '../../common/services/mail.service';

const DEFAULT_PAGE_SIZE = 20;

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceGen: InvoiceGeneratorService,
    private readonly limitNotifier: LimitNotifierService,
    private readonly aiMetering: AiMeteringService,
    private readonly companyStatus: CompanyStatusService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async listInvoices(companyId: number, dto: ListInvoicesDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    const skip = (page - 1) * limit;

    const where: Prisma.InvoiceWhereInput = { company_id: companyId };
    if (dto.status) where.status = dto.status;

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
      data: numifyDecimals(rows),
      message: 'OK',
      meta: { page, limit, total },
    };
  }

  async getInvoice(companyId: number, id: number) {
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
    if (!inv) throw new NotFoundException('Invoice not found');
    const { company, ...rest } = inv;
    return numifyDecimals({
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

  async getSubscription(companyId: number) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: { subscription: true },
    });
    if (!company?.subscription) {
      throw new NotFoundException('Subscription not found');
    }
    const period = new Date().toISOString().slice(0, 7);
    // contacts/templates = LIVE stored counts (cumulative vs the plan cap);
    // messages/webhooks/conversations = this-month consumption counters.
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

    // AI accrues post-paid: what's been spent in the CURRENT activation cycle is
    // added to the NEXT invoice. Surface it so the tenant isn't surprised.
    // Window = the activation-anchored 30-day cycle that contains "now".
    let aiUsage: {
      billedCents: number;
      cycleStart: string;
      nextInvoiceDate: string;
    } | null = null;
    if (sub.ai_enabled && company.ai_enabled && company.activated_at) {
      try {
        const idx = InvoiceGeneratorService.cycleIndex(
          company.activated_at,
          new Date(),
        );
        if (idx >= 0) {
          const cycleStart = InvoiceGeneratorService.cycleStart(
            company.activated_at,
            idx,
          );
          const nextStart = InvoiceGeneratorService.cycleStart(
            company.activated_at,
            idx + 1,
          );
          const costMicros = await this.aiMetering.sumCostMicros(
            companyId,
            cycleStart,
            new Date(),
          );
          aiUsage = {
            billedCents: await this.aiMetering.billedCentsFor(costMicros),
            cycleStart: cycleStart.toISOString(),
            nextInvoiceDate: nextStart.toISOString(),
          };
        }
      } catch {
        // best-effort — never block the billing page on a metering read
      }
    }

    return numifyDecimals({
      plan: sub.plan_name,
      monthlyPrice: sub.monthly_price,
      limits: {
        contactLimit: sub.contact_limit,
        templateLimit: sub.template_limit,
        userLimit: sub.user_limit,
      },
      // Accruing AI charges for the current cycle (added to the next invoice).
      aiUsage,
      // Plan feature flags (so the tenant UI can gate features it doesn't have).
      // ai = plan allows AND the company hasn't turned it off.
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

  // ─── Super-admin ───────────────────────────────────────────────────────────

  async overview() {
    const [byPlan, overdue] = await Promise.all([
      this.prisma.$queryRawUnsafe<
        { plan_name: string; companies: bigint; mrr: string }[]
      >(
        `SELECT s.plan_name plan_name,
                COUNT(c.id) companies,
                SUM(s.monthly_price) mrr
         FROM companies c
         JOIN subscriptions s ON s.id = c.subscription_id
         WHERE c.activation_status = 'active'
         GROUP BY s.plan_name`,
      ),
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

  async markPaid(invoiceId: number) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    });
    if (!inv) throw new NotFoundException('Invoice not found');

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

  /**
   * Auto-reactivate a company that was auto-suspended for non-payment,
   * once it has no remaining unpaid (pending/overdue) invoices.
   * No-op for companies that aren't suspended or were suspended manually
   * by a super-admin while still having debt.
   */
  private async maybeReactivate(companyId: number) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { activation_status: true, suspended_at: true },
    });
    // Only auto-lift suspensions the billing cron applied (suspended_at set).
    if (
      !company ||
      company.activation_status !== 'suspended' ||
      !company.suspended_at
    ) {
      return;
    }
    const stillOwes = await this.prisma.invoice.count({
      where: { company_id: companyId, status: { in: ['pending', 'overdue'] } },
    });
    if (stillOwes > 0) return;

    await this.prisma.company.update({
      where: { id: companyId },
      data: { activation_status: 'active', suspended_at: null },
    });
    this.companyStatus.invalidate(companyId); // resume outbound immediately
  }

  async generateInvoices() {
    return this.invoiceGen.generateDueInvoices();
  }

  /**
   * Rewrite legacy (pre-billing-lifecycle) invoices to the canonical
   * activation-anchored format. HTTP-callable mirror of the CLI script
   * `backend/scripts/rewrite-legacy-invoices.ts` — same logic, exposed
   * via the super-admin billing controller so Business-plan tenants
   * (no SSH) can run it from the panel.
   *
   * NEVER touches status, paid_at, or amount. Skips invoices whose
   * company has no activated_at and any that would collide with an
   * existing canonical invoice_number.
   */
  async rewriteLegacyInvoices(opts: {
    dryRun: boolean;
    companyId?: number | null;
  }): Promise<{
    mode: 'dry-run' | 'apply';
    inspected: number;
    candidates: number;
    skipped: number;
    updated: number;
    collisions: Array<{ id: number; collidesWith: number }>;
    changes: Array<{
      id: number;
      companyId: number;
      companyName: string | null;
      oldNumber: string | null;
      newNumber: string;
      newDueDate: string;
      newPeriod: string;
    }>;
  }> {
    const CYCLE_DAYS = 30;
    const DUE_DAYS = 7;
    const DAY_MS = 86_400_000;
    const RE_CYCLE = /^INV-\d+-\d{8}$/;
    const RE_OFFCYCLE = /^INV-\d+-OFF-/;
    const isLegacy = (n: string | null) =>
      !n || (!RE_CYCLE.test(n) && !RE_OFFCYCLE.test(n));
    const ymd = (d: Date) =>
      d.toISOString().slice(0, 10).replace(/-/g, '');

    const invoices = await this.prisma.invoice.findMany({
      where:
        opts.companyId && Number.isFinite(opts.companyId)
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
    const collisions: Array<{ id: number; collidesWith: number }> = [];
    const changes: Array<{
      id: number;
      companyId: number;
      companyName: string | null;
      oldNumber: string | null;
      newNumber: string;
      newDueDate: string;
      newPeriod: string;
    }> = [];

    for (const inv of invoices) {
      inspected++;
      if (!isLegacy(inv.invoice_number)) continue;
      const c = inv.company;
      if (!c?.activated_at) {
        skipped++;
        continue;
      }
      const elapsed = inv.created_at.getTime() - c.activated_at.getTime();
      const cycleIndex = Math.max(
        0,
        Math.floor(elapsed / (CYCLE_DAYS * DAY_MS)),
      );
      const cycleStart = new Date(
        c.activated_at.getTime() + cycleIndex * CYCLE_DAYS * DAY_MS,
      );
      const newNumber = `INV-${inv.company_id}-${ymd(cycleStart)}`;
      const newDueDate = new Date(cycleStart.getTime() + DUE_DAYS * DAY_MS);
      const newPeriod = cycleStart.toISOString().slice(0, 7);
      const planName =
        c.subscription?.plan_name ?? 'Subscription';
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
        const oldSnapshot =
          (inv.plan_snapshot as Record<string, unknown> | null) ?? {};
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
        } catch {
          /* swallow — surfaced via skipped count */
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

  // ─── Cron ──────────────────────────────────────────────────────────────────

  /** Daily: raise any due-but-missing invoice (activation-anchored 30d). */
  async autoInvoiceCron() {
    const result = await this.invoiceGen.generateDueInvoices();
    return { ran: true, ...result };
  }

  /**
   * Daily enforcement:
   *  1. pending → overdue once due_date has passed.
   *  2. suspend companies with an invoice overdue ≥ SUSPEND_GRACE_DAYS,
   *     unless a super-admin granted extra time (grace_until in future).
   */
  async enforceCron() {
    const SUSPEND_GRACE_DAYS = 3;
    const now = new Date();

    const flagged = await this.prisma.invoice.updateMany({
      where: { status: 'pending', due_date: { lt: now } },
      data: { status: 'overdue' },
    });

    const suspendThreshold = new Date(
      now.getTime() - SUSPEND_GRACE_DAYS * 86_400_000,
    );
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
      if (!company || company.activation_status !== 'active') continue;
      if (company.grace_until && company.grace_until > now) continue;

      await this.prisma.company.update({
        where: { id: company_id },
        data: { activation_status: 'suspended', suspended_at: now },
      });
      this.companyStatus.invalidate(company_id); // pause outbound immediately
      suspended++;
      // Phase 4.5: fire suspension email (non-blocking — we still want to
      // suspend the rest of the cohort even if SMTP is flaky).
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

  /**
   * Surfaced to a (possibly suspended) tenant owner so the frontend can
   * render a billing-blocked screen. JWT-only — must NOT be tenant-guarded.
   */
  async accountStatus(companyId: number) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { activation_status: true, suspended_at: true, grace_until: true },
    });
    if (!company) throw new NotFoundException('Company not found');

    const unpaid = await this.prisma.invoice.findMany({
      where: {
        company_id: companyId,
        status: { in: ['pending', 'overdue'] },
      },
      orderBy: { due_date: 'asc' },
    });

    const suspendedForBilling =
      company.activation_status === 'suspended' &&
      !!company.suspended_at &&
      unpaid.length > 0;

    return numifyDecimals({
      activationStatus: company.activation_status,
      suspendedForBilling,
      suspendedAt: company.suspended_at,
      graceUntil: company.grace_until,
      unpaidInvoices: unpaid,
    });
  }

  // ── Plan-change / upgrade requests (tenant side) ──────────────────────

  /** The tenant's most recent plan-change request (for the /billing UI). */
  async getMyPlanRequest(companyId: number) {
    const req = await this.prisma.planChangeRequest.findFirst({
      where: { company_id: companyId },
      orderBy: { id: 'desc' },
    });
    if (!req) return { request: null };
    const requested = req.requested_subscription_id
      ? await this.prisma.subscription.findUnique({
          where: { id: req.requested_subscription_id },
          select: { plan_name: true },
        })
      : null;
    return {
      request: { ...req, requestedPlanName: requested?.plan_name ?? null },
    };
  }

  /**
   * Raise a plan-change request for super-admin review. No payment gateway —
   * a super-admin approves and the subscription is switched. One open request
   * at a time. owner/admin only (enforced at the controller).
   */
  async requestPlanChange(
    companyId: number,
    userId: number | null,
    dto: RequestPlanChangeDto,
  ) {
    const existing = await this.prisma.planChangeRequest.findFirst({
      where: { company_id: companyId, status: 'pending' },
    });
    if (existing) {
      throw new BadRequestException(
        'You already have a plan-change request pending review.',
      );
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { company_name: true, subscription_id: true },
    });
    if (!company) throw new NotFoundException('Company not found');

    // Validate the requested plan (if any) is a real, public plan.
    let requestedName: string | null = null;
    if (dto.requestedSubscriptionId != null) {
      const plan = await this.prisma.subscription.findUnique({
        where: { id: dto.requestedSubscriptionId },
        select: { plan_name: true },
      });
      if (!plan) throw new BadRequestException('Unknown plan selected.');
      requestedName = plan.plan_name;
    }

    const request = await this.prisma.planChangeRequest.create({
      data: {
        company_id: companyId,
        requested_subscription_id: dto.requestedSubscriptionId ?? null,
        current_subscription_id: company.subscription_id,
        note: dto.note?.trim() || null,
        created_by_user_id: userId,
        status: 'pending',
      },
    });

    // Notify the super-admin (best-effort; MailService never throws).
    const adminEmail =
      this.config.get<string>('SUPER_ADMIN_EMAIL') ?? null;
    if (adminEmail) {
      void this.mail.send(
        adminEmail,
        `Plan-change request — ${company.company_name}`,
        `<p><strong>${company.company_name}</strong> requested a plan change.</p>` +
          `<p>Requested plan: ${requestedName ?? '(wants to discuss)'}</p>` +
          (dto.note ? `<p>Note: ${dto.note}</p>` : '') +
          `<p>Review it in the super-admin → Upgrade requests screen.</p>`,
      );
    }

    return { request: { ...request, requestedPlanName: requestedName } };
  }
}
