import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CourierType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CourierRegistryService } from './courier-registry.service';
import { CityMappingService } from './city-mapping.service';
import { InboxService } from '../inbox/inbox.service';
import { SendMessageType } from '../inbox/dto/send-message.dto';
import { COURIER_DISPLAY_NAME, COURIER_TRACKING_URL } from './couriers.constants';
import type { CreateReplacementDto } from './dto/create-replacement.dto';

/**
 * Ticket-driven replacement shipments (Option A).
 *
 * A replacement is a NEW outbound parcel — usually COD 0 — for an order whose
 * original parcel was returned / damaged / wrong. It is booked on the SAME
 * PostEx/Trax (etc.) adapters the fulfillment queue uses, then persisted as a
 * REAL `shipment` row so it inherits status-sync, the tracking view, label /
 * loadsheet download and courier-invoice reconciliation for free.
 *
 * The row is stored under a SUFFIXED `shopify_order_gid` ("<gid>#R1") so the
 * existing per-order unique key is untouched; `original_order_gid` +
 * `replacement_of_ticket_id` keep the links back to the order and the ticket,
 * and `contact_id` / `conversation_id` link it to the customer.
 */
@Injectable()
export class ReplacementShipmentService {
  private readonly logger = new Logger(ReplacementShipmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CourierRegistryService,
    private readonly cityMapping: CityMappingService,
    private readonly inbox: InboxService,
  ) {}

  /** Tenant-scoped ticket load (with contact), or 404. */
  private async requireTicket(companyId: number, ticketId: number) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id: ticketId, company_id: companyId },
      include: { contact: { select: { id: true, name: true, phone: true } } },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  /** The order mirror behind a ticket's linked order (name → mirror row), if any. */
  private async loadOrderMirror(companyId: number, orderName: string | null) {
    if (!orderName) return null;
    return this.prisma.shopifyOrder.findFirst({
      where: { company_id: companyId, order_name: orderName },
    });
  }

  private itemsFromMirror(mirror: {
    line_items_summary: string | null;
  } | null): string {
    return mirror?.line_items_summary?.trim() || 'Replacement item';
  }

  /**
   * Pre-fill + options for the replacement form: the destination from the order
   * mirror (the same source booking trusts), the customer, the tenant's active
   * couriers with per-courier city serviceability, and any replacements already
   * booked for this ticket.
   */
  async context(companyId: number, ticketId: number) {
    const ticket = await this.requireTicket(companyId, ticketId);
    const mirror = await this.loadOrderMirror(
      companyId,
      ticket.linked_order_name,
    );

    const city = mirror?.city ?? '';
    const active = await this.registry.getActiveCouriers(companyId);
    const couriers = await Promise.all(
      active.map(async (courierType) => {
        const cityCode = city
          ? await this.cityMapping.resolve(companyId, courierType, city)
          : null;
        return {
          courierType,
          label: COURIER_DISPLAY_NAME[courierType],
          serves: !!cityCode,
        };
      }),
    );

    const replacements = await this.listForTicket(companyId, ticketId);

    return {
      ticket: {
        id: ticket.id,
        ticketNumber: ticket.ticket_number,
        type: ticket.type,
        linkedOrderName: ticket.linked_order_name,
      },
      prefill: {
        name: mirror?.customer_name ?? ticket.contact?.name ?? '',
        phone: mirror?.phone ?? ticket.contact?.phone ?? '',
        email: mirror?.email ?? '',
        city,
        address1: mirror?.address1 ?? '',
        address2: mirror?.address2 ?? '',
        contents: `Replacement: ${this.itemsFromMirror(mirror)}`,
        orderTotal: mirror?.total_price != null ? Number(mirror.total_price) : null,
        currency: mirror?.currency ?? null,
      },
      couriers,
      replacements,
    };
  }

  /** Replacement parcels already booked for a ticket, newest first. */
  async listForTicket(companyId: number, ticketId: number) {
    const rows = await this.prisma.shipment.findMany({
      where: {
        company_id: companyId,
        replacement_of_ticket_id: ticketId,
        is_replacement: true,
      },
      orderBy: { id: 'desc' },
      select: {
        id: true,
        courier_type: true,
        courier_tracking_number: true,
        status: true,
        destination_city: true,
        created_at: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      courierType: r.courier_type,
      courierLabel: COURIER_DISPLAY_NAME[r.courier_type],
      trackingNumber: r.courier_tracking_number,
      trackingUrl: r.courier_tracking_number
        ? COURIER_TRACKING_URL[r.courier_type]?.(r.courier_tracking_number) ?? null
        : null,
      status: r.status,
      city: r.destination_city,
      createdAt: r.created_at,
    }));
  }

  /**
   * Book a replacement parcel and persist it. Books at the courier FIRST and
   * only writes the shipment row on success, so a booking failure never leaves a
   * track-less orphan (mirrors the create-order flow). Tenant-scoped throughout.
   */
  async book(
    companyId: number,
    userId: number,
    dto: CreateReplacementDto,
    returnImage?: { buffer: Buffer; mime: string; filename: string },
  ) {
    const ticket = await this.requireTicket(companyId, dto.ticketId);
    const mirror = await this.loadOrderMirror(
      companyId,
      ticket.linked_order_name,
    );

    // Trax replacement is a two-legged shipment (deliver the new item + pick up
    // the old one) and REQUIRES a description of the item being taken back.
    // PostEx's 'Replacement' order type carries no return-item fields.
    if (dto.courierType === 'trax' && !dto.returnItemDescription?.trim()) {
      throw new BadRequestException(
        'Trax replacement needs the item being taken back — add its description.',
      );
    }

    // Resolve the courier's expected city value (numeric id for Trax, canonical
    // name for PostEx). Throws a clean 4xx when the city isn't served — before
    // any booking attempt.
    const cityCode = await this.cityMapping.requireCode(
      companyId,
      dto.courierType,
      dto.city,
    );

    const { credentialId, creds } = await this.registry.requireCredentials(
      companyId,
      dto.courierType,
    );
    const adapter = this.registry.getAdapter(dto.courierType);

    // A stable, human-traceable reference: the order name + the next replacement
    // index for this ticket (e.g. "#1042-R1"). Also drives the suffixed gid.
    const priorCount = await this.prisma.shipment.count({
      where: {
        company_id: companyId,
        replacement_of_ticket_id: dto.ticketId,
        is_replacement: true,
      },
    });
    const rIndex = priorCount + 1;
    const baseName = ticket.linked_order_name || `TICKET-${ticket.ticket_number}`;
    const replacementRef = `${baseName}-R${rIndex}`;
    const originalGid = mirror?.shopify_order_gid ?? null;
    // Suffixed gid keeps the existing `@@unique([company_id, shopify_order_gid])`
    // intact. When there's no linked order, key off the ticket.
    const suffixedGid = originalGid
      ? `${originalGid}#R${rIndex}`
      : `ticket:${ticket.id}#R${rIndex}`;

    const codAmount = Math.max(0, Math.round(dto.codAmount));
    const totalPrice =
      mirror?.total_price != null ? Number(mirror.total_price) : undefined;

    let trackingNumber: string;
    let bookRaw: unknown;
    try {
      const result = await adapter.bookShipment(creds, {
        companyId,
        shopifyOrderName: replacementRef,
        destination: {
          name: dto.name,
          phone: dto.phone,
          city: dto.city,
          cityCode,
          address1: dto.address1,
          address2: dto.address2,
        },
        codAmount,
        itemsDescription: dto.contents,
        pieces: 1,
        email: dto.email ?? mirror?.email ?? undefined,
        totalPrice,
        totalQuantity: 1,
        // Mark it at the courier as a replacement (PostEx orderType 'Replacement',
        // Trax service_type_id 2) and describe the item being taken back.
        isReplacement: true,
        returnItem: dto.returnItemDescription?.trim()
          ? {
              description: dto.returnItemDescription.trim(),
              quantity: dto.returnItemQuantity ?? 1,
              productTypeId: dto.returnItemProductTypeId,
              image: returnImage,
            }
          : undefined,
      });
      trackingNumber = result.trackingNumber;
      bookRaw = result.raw;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `Replacement booking failed (ticket ${dto.ticketId}, ${dto.courierType}): ${msg}`,
      );
      throw new BadRequestException(
        `${COURIER_DISPLAY_NAME[dto.courierType]} booking failed. ${msg}`,
      );
    }

    const shipment = await this.prisma.shipment.create({
      data: {
        company_id: companyId,
        shopify_order_gid: suffixedGid,
        shopify_order_name: replacementRef,
        original_order_gid: originalGid,
        is_replacement: true,
        replacement_of_ticket_id: ticket.id,
        conversation_id: ticket.conversation_id,
        contact_id: ticket.contact_id,
        courier_type: dto.courierType,
        courier_credential_id: credentialId,
        courier_tracking_number: trackingNumber,
        courier_city_code: cityCode,
        destination_city: dto.city,
        destination_address: [dto.address1, dto.address2]
          .filter(Boolean)
          .join(', '),
        status: 'booked',
        booked_at: new Date(),
        raw_last_webhook: bookRaw as object,
        created_by_user_id: userId,
      },
    });

    // Timeline event on the ticket (best-effort — the parcel is already booked).
    await this.prisma.ticketEvent
      .create({
        data: {
          company_id: companyId,
          ticket_id: ticket.id,
          kind: 'replacement_booked',
          actor: 'agent',
          user_id: userId,
          body:
            `Replacement booked · ${COURIER_DISPLAY_NAME[dto.courierType]} · ` +
            `CN ${trackingNumber} · COD ${codAmount} · to ${dto.city}`,
        },
      })
      .catch((e) =>
        this.logger.warn(
          `replacement event not written (ticket ${ticket.id}): ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      );
    await this.prisma.supportTicket
      .update({ where: { id: ticket.id }, data: { updated_at: new Date() } })
      .catch(() => undefined);

    // Send the customer their new tracking number on WhatsApp (best-effort —
    // a closed 24h window / send failure must NEVER fail the booking).
    const trackingUrl =
      COURIER_TRACKING_URL[dto.courierType]?.(trackingNumber) ?? null;
    try {
      await this.inbox.sendMessage(
        companyId,
        ticket.conversation_id,
        {
          type: SendMessageType.text,
          content:
            `📦 Aap ka replacement parcel book kar diya gaya hai.\n` +
            `Courier: ${COURIER_DISPLAY_NAME[dto.courierType]}\n` +
            `Tracking #: ${trackingNumber}` +
            (trackingUrl ? `\n${trackingUrl}` : '') +
            `\nShukria!`,
        },
        userId,
      );
    } catch (e) {
      this.logger.debug(
        `replacement tracking not sent (convo ${ticket.conversation_id}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    return {
      shipment: {
        id: shipment.id,
        courierType: dto.courierType,
        courierLabel: COURIER_DISPLAY_NAME[dto.courierType],
        trackingNumber,
        trackingUrl,
        status: shipment.status,
      },
    };
  }
}
