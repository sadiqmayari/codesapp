import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const DUE_DAYS = 7;

/**
 * Creates one invoice per active company for a billing period. Idempotent:
 * a company that already has an invoice with `period = <YYYY-MM>` is skipped.
 */
@Injectable()
export class InvoiceGeneratorService {
  private readonly logger = new Logger(InvoiceGeneratorService.name);

  constructor(private readonly prisma: PrismaService) {}

  static currentPeriod(): string {
    return new Date().toISOString().slice(0, 7);
  }

  static invoiceNumber(period: string, companyId: number): string {
    return `INV-${period.replace('-', '')}-${companyId}`;
  }

  async generateForPeriod(period: string): Promise<{
    period: string;
    created: number;
    skipped: number;
  }> {
    const companies = await this.prisma.company.findMany({
      where: { activation_status: 'active' },
      include: { subscription: true },
    });

    let created = 0;
    let skipped = 0;

    for (const company of companies) {
      const existing = await this.prisma.invoice.findFirst({
        where: { company_id: company.id, period },
      });
      if (existing) {
        skipped++;
        continue;
      }

      const sub = company.subscription;
      const dueDate = new Date(Date.now() + DUE_DAYS * 86_400_000);
      try {
        await this.prisma.invoice.create({
          data: {
            company_id: company.id,
            amount: sub.monthly_price,
            status: 'pending',
            due_date: dueDate,
            invoice_number: InvoiceGeneratorService.invoiceNumber(
              period,
              company.id,
            ),
            period,
            description: `${sub.plan_name} plan — ${period}`,
            plan_snapshot: {
              plan_name: sub.plan_name,
              monthly_price: sub.monthly_price.toString(),
              contact_limit: sub.contact_limit,
              template_limit: sub.template_limit,
              user_limit: sub.user_limit,
            } as Prisma.InputJsonValue,
          },
        });
        created++;
      } catch (err) {
        // Unique-constraint race (idx_invoices_number) → another run already
        // created it. Treat as skipped, not an error.
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

    return { period, created, skipped };
  }
}
