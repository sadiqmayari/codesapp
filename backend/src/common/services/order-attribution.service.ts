import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export type AttributionKind =
  | 'created'
  | 'confirmed'
  | 'packed'
  | 'booked'
  | 'dispatched'
  | 'returned_received';

/**
 * THE order-attribution ledger (order_attributions): who did what to an order.
 * One row per (company, order, kind) — the unique key stops double counting
 * (re-clicking confirm, re-booking). First writer wins, except `force` (a
 * re-pack/re-book by someone else moves the credit). Best-effort: never throws,
 * so a ledger failure can't break the confirm/book/pack it records.
 * Commission plans read ONLY this table (+ the order/shipment outcome).
 */
@Injectable()
export class OrderAttributionService {
  private readonly log = new Logger(OrderAttributionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(
    companyId: number,
    userId: number | null | undefined,
    kind: AttributionKind,
    order: { gid: string | null | undefined; name?: string | null; value?: number | null; source?: string | null },
    opts: { at?: Date; force?: boolean } = {},
  ): Promise<void> {
    if (!userId || !order.gid) return;
    // Replacement parcels (<gid>#R1) credit against their own suffixed key.
    const gid = order.gid.slice(0, 255);
    try {
      const data = {
        user_id: userId,
        order_name: order.name?.slice(0, 64) ?? null,
        value: order.value ?? null,
        source: order.source?.slice(0, 24) ?? null,
        at: opts.at ?? new Date(),
      };
      await this.prisma.orderAttribution.upsert({
        where: { company_id_order_gid_kind: { company_id: companyId, order_gid: gid, kind } },
        create: { company_id: companyId, order_gid: gid, kind, ...data },
        update: opts.force ? data : {},
      });
    } catch (e) {
      this.log.debug(`attribution ${kind} failed for ${gid}: ${(e as Error).message}`);
    }
  }

  /** Remove a credit (e.g. a booking was cancelled before dispatch). */
  async remove(companyId: number, gid: string | null | undefined, kind: AttributionKind): Promise<void> {
    if (!gid) return;
    try {
      await this.prisma.orderAttribution.deleteMany({ where: { company_id: companyId, order_gid: gid, kind } });
    } catch {
      /* best-effort */
    }
  }
}
