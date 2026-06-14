import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Records facts already communicated to the customer for a work item, so the AI
 * does not restate identical information (the "AI repeating order status" bug).
 *
 * fact_kind encodes WHAT (e.g. `order_status:#1234`); fact_hash is a hash of the
 * exact VALUE shared (e.g. the delivery status). A repeat with the same hash =
 * "already told this, don't restate"; a different hash = the value CHANGED =
 * genuinely new info, allowed. All methods best-effort / never-throw.
 */
@Injectable()
export class ToldLedgerService {
  private readonly logger = new Logger(ToldLedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  private hash(value: string): string {
    return createHash('sha1').update(value).digest('hex');
  }

  /**
   * Returns true if this exact fact was ALREADY recorded for the work item
   * (i.e. we have told the customer this before). Records it if new.
   */
  async noteAndCheck(
    companyId: number,
    workItemId: number,
    factKind: string,
    value: string,
  ): Promise<{ alreadyTold: boolean }> {
    try {
      const fact_hash = this.hash(value);
      const existing = await this.prisma.toldLedger.findFirst({
        where: { work_item_id: workItemId, fact_kind: factKind, fact_hash },
        select: { id: true },
      });
      if (existing) return { alreadyTold: true };
      await this.prisma.toldLedger.create({
        data: {
          company_id: companyId,
          work_item_id: workItemId,
          fact_kind: factKind,
          fact_hash,
        },
      });
      return { alreadyTold: false };
    } catch (e) {
      // Unique race or any error → treat as not-already-told (fail toward
      // answering rather than silently withholding).
      this.logger.debug(
        `told-ledger noteAndCheck skipped (wi ${workItemId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return { alreadyTold: false };
    }
  }

  /** Distinct fact kinds already shared for a work item (for prompt injection). */
  async kindsTold(workItemId: number): Promise<string[]> {
    try {
      const rows = await this.prisma.toldLedger.findMany({
        where: { work_item_id: workItemId },
        select: { fact_kind: true },
        distinct: ['fact_kind'],
        take: 20,
      });
      return rows.map((r) => r.fact_kind);
    } catch {
      return [];
    }
  }
}
