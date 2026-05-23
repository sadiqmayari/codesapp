import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LimitWarningService } from '../billing/limit-warning.service';
import { LimitNotifierService } from '../billing/limit-notifier.service';

@Injectable()
export class UsageMeteringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limitWarning: LimitWarningService,
    private readonly limitNotifier: LimitNotifierService,
  ) {}

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

    // 80% soft-limit warning (idempotent per period+dimension).
    await this.limitWarning.check(companyId, field);

    // Phase 4.5: 90/99/100 notifications (fire-once via thresholds_notified).
    await this.limitNotifier.evaluate(companyId, field);
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

}
