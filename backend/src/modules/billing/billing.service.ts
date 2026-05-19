import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InvoiceGeneratorService } from './invoice-generator.service';
import { ListInvoicesDto } from './dtos/list-invoices.dto';
import { numifyDecimals } from '../../common/utils/decimal';

const DEFAULT_PAGE_SIZE = 20;

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceGen: InvoiceGeneratorService,
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
    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'paid', paid_at: new Date() },
    });
  }

  async generateInvoices() {
    const period = InvoiceGeneratorService.currentPeriod();
    return this.invoiceGen.generateForPeriod(period);
  }

  // ─── Cron ──────────────────────────────────────────────────────────────────

  async autoInvoiceCron() {
    const today = new Date();
    if (today.getDate() !== 1) {
      return {
        ran: false,
        reason: 'not first of month',
        day: today.getDate(),
      };
    }
    const period = InvoiceGeneratorService.currentPeriod();
    const result = await this.invoiceGen.generateForPeriod(period);
    return { ran: true, ...result };
  }
}
