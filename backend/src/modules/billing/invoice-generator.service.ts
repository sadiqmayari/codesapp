import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiMeteringService } from '../ai/ai-metering.service';

const CYCLE_DAYS = 30;
const DUE_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * Activation-anchored billing. Each company is billed in fixed 30-day
 * cycles counted from `companies.activated_at` (set once on the FIRST
 * super-admin activation, never moved on reactivation). Cycle 0 starts
 * on the activation instant, so the first invoice is raised immediately
 * on activation (prepaid), then one every 30 days.
 *
 * Idempotent: the per-cycle `invoice_number` is unique
 * (`INV-{companyId}-{cycleStartYYYYMMDD}`) so a company already invoiced
 * for the current cycle is skipped. The cron is safe to run daily.
 */
@Injectable()
export class InvoiceGeneratorService {
  private readonly logger = new Logger(InvoiceGeneratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiMetering: AiMeteringService,
  ) {}

  /** Legacy helper kept for callers/tests — current calendar period. */
  static currentPeriod(): string {
    return new Date().toISOString().slice(0, 7);
  }

  /** Zero-based cycle index for `now` relative to the activation anchor. */
  static cycleIndex(activatedAt: Date, now: Date): number {
    const elapsed = now.getTime() - activatedAt.getTime();
    if (elapsed < 0) return -1;
    return Math.floor(elapsed / (CYCLE_DAYS * DAY_MS));
  }

  static cycleStart(activatedAt: Date, index: number): Date {
    return new Date(activatedAt.getTime() + index * CYCLE_DAYS * DAY_MS);
  }

  static invoiceNumber(companyId: number, cycleStart: Date): string {
    const ymd = cycleStart.toISOString().slice(0, 10).replace(/-/g, '');
    return `INV-${companyId}-${ymd}`;
  }

  /**
   * Raise any due-but-missing invoice for every active company.
   * `now` is injectable for tests.
   */
  async generateDueInvoices(now: Date = new Date()): Promise<{
    created: number;
    skipped: number;
  }> {
    const companies = await this.prisma.company.findMany({
      where: { activation_status: 'active', activated_at: { not: null } },
      include: { subscription: true },
    });

    let created = 0;
    let skipped = 0;

    for (const company of companies) {
      const activatedAt = company.activated_at!;
      const index = InvoiceGeneratorService.cycleIndex(activatedAt, now);
      if (index < 0) {
        skipped++;
        continue;
      }
      const cycleStart = InvoiceGeneratorService.cycleStart(
        activatedAt,
        index,
      );
      const invoiceNumber = InvoiceGeneratorService.invoiceNumber(
        company.id,
        cycleStart,
      );

      const existing = await this.prisma.invoice.findUnique({
        where: { invoice_number: invoiceNumber },
      });
      if (existing) {
        skipped++;
        continue;
      }

      const sub = company.subscription;
      const dueDate = new Date(now.getTime() + DUE_DAYS * DAY_MS);
      const period = cycleStart.toISOString().slice(0, 7);

      // Post-paid AI usage (arrears): bill the PREVIOUS cycle's metered AI
      // cost (raw provider cost x markup) on this cycle's invoice. Cycle 0
      // has no prior window, so no AI line. Best-effort — a metering read
      // failure must not block plan invoicing.
      let aiBilledCents = 0;
      let aiCostMicros = 0;
      if (index > 0) {
        try {
          const prevStart = InvoiceGeneratorService.cycleStart(
            activatedAt,
            index - 1,
          );
          aiCostMicros = await this.aiMetering.sumCostMicros(
            company.id,
            prevStart,
            cycleStart,
          );
          aiBilledCents = await this.aiMetering.billedCentsFor(aiCostMicros);
        } catch (e) {
          this.logger.warn(
            `AI arrears calc failed for company ${company.id}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }

      const amount = aiBilledCents
        ? new Prisma.Decimal(sub.monthly_price).plus(aiBilledCents / 100)
        : sub.monthly_price;
      const aiDescr = aiBilledCents
        ? ` + AI usage $${(aiBilledCents / 100).toFixed(2)}`
        : '';

      try {
        await this.prisma.invoice.create({
          data: {
            company_id: company.id,
            amount,
            status: 'pending',
            due_date: dueDate,
            invoice_number: invoiceNumber,
            period,
            description: `${sub.plan_name} plan — cycle starting ${cycleStart
              .toISOString()
              .slice(0, 10)}${aiDescr}`,
            plan_snapshot: {
              plan_name: sub.plan_name,
              monthly_price: sub.monthly_price.toString(),
              contact_limit: sub.contact_limit,
              template_limit: sub.template_limit,
              user_limit: sub.user_limit,
              cycle_index: index,
              cycle_start: cycleStart.toISOString(),
              ai_usage: aiBilledCents
                ? {
                    cost_micros: aiCostMicros,
                    billed_cents: aiBilledCents,
                    window_start: InvoiceGeneratorService.cycleStart(
                      activatedAt,
                      index - 1,
                    ).toISOString(),
                    window_end: cycleStart.toISOString(),
                  }
                : null,
            } as Prisma.InputJsonValue,
          },
        });
        created++;
      } catch (err) {
        // Unique-constraint race (idx_invoices_number) → another run
        // already created it. Treat as skipped, not an error.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          skipped++;
          continue;
        }
        this.logger.warn(
          `Invoice generation failed for company ${company.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return { created, skipped };
  }
}
