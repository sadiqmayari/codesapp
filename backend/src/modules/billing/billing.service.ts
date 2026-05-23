import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InvoiceGeneratorService } from './invoice-generator.service';
import { LimitNotifierService } from './limit-notifier.service';
import { ListInvoicesDto } from './dtos/list-invoices.dto';
import { numifyDecimals } from '../../common/utils/decimal';

const DEFAULT_PAGE_SIZE = 20;

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceGen: InvoiceGeneratorService,
    private readonly limitNotifier: LimitNotifierService,
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
    });
    if (!inv) throw new NotFoundException('Invoice not found');
    return numifyDecimals(inv);
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
    const usage = await this.prisma.usageMetering.findUnique({
      where: { company_id_period: { company_id: companyId, period } },
    });
    const sub = company.subscription;
    return numifyDecimals({
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
  }

  async generateInvoices() {
    return this.invoiceGen.generateDueInvoices();
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
}
