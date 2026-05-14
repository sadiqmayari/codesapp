import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class UsageMeteringService {
  private readonly logger = new Logger(UsageMeteringService.name);

  constructor(private readonly prisma: PrismaService) {}

  private currentPeriod(): string {
    return new Date().toISOString().slice(0, 7); // YYYY-MM
  }

  private async increment(
    companyId: number,
    field: string,
    amount = 1,
  ): Promise<void> {
    const period = this.currentPeriod();

    // Upsert the row, then atomically increment the field
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO usage_metering (company_id, period, ${field}, updated_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE ${field} = ${field} + ?, updated_at = NOW()`,
      companyId,
      period,
      amount,
      amount,
    );

    // Check 80% warning after increment
    await this.check80PercentWarning(companyId, period);
  }

  async incrementMessages(companyId: number): Promise<void> {
    await this.increment(companyId, 'messages_sent');
  }

  async incrementContacts(companyId: number): Promise<void> {
    await this.increment(companyId, 'contacts_stored');
  }

  async incrementTemplates(companyId: number): Promise<void> {
    await this.increment(companyId, 'templates_used');
  }

  async incrementWebhookCalls(companyId: number): Promise<void> {
    await this.increment(companyId, 'webhook_calls');
  }

  async incrementConversations(companyId: number): Promise<void> {
    await this.increment(companyId, 'conversations_opened');
  }

  async getUsage(companyId: number) {
    const period = this.currentPeriod();
    return this.prisma.usageMetering.findUnique({
      where: { company_id_period: { company_id: companyId, period } },
    });
  }

  private async check80PercentWarning(companyId: number, period: string): Promise<void> {
    const [usage, company] = await Promise.all([
      this.prisma.usageMetering.findUnique({
        where: { company_id_period: { company_id: companyId, period } },
      }),
      this.prisma.company.findUnique({
        where: { id: companyId },
        include: { subscription: true },
      }),
    ]);

    if (!usage || !company) return;

    const sub = company.subscription;
    const warnings: string[] = [];

    if (usage.contacts_stored >= sub.contact_limit * 0.8) warnings.push('contacts');
    if (usage.templates_used >= sub.template_limit * 0.8) warnings.push('templates');

    if (warnings.length > 0) {
      this.logger.warn(
        `Company ${companyId} at 80% limit for: ${warnings.join(', ')}`,
      );

      // TODO: Fire webhook event subscription.limit.warning
      // Payload shape when webhook module exists (Phase 3):
      // {
      //   event: 'subscription.limit.warning',
      //   companyId,
      //   warnings: warnings.map(w => ({
      //     resource: w,
      //     current: usage[`${w}_stored` || `${w}_used`],
      //     limit: sub[`${w}_limit`],
      //     percentage: Math.round((current / limit) * 100),
      //   })),
      // }
    }
  }
}
