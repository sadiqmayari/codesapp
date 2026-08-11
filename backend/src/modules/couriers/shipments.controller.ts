import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CourierType, ShipmentStatus } from '@prisma/client';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ShipmentService, QueueStatus } from './shipment.service';
import { ShipmentTrackingService } from './shipment-tracking.service';
import { CourierStatusSyncService } from './courier-status-sync.service';
import { CourierOpsService } from './courier-ops.service';
import { CityMappingService } from './city-mapping.service';
import { LoadsheetService } from './loadsheet.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { BookShipmentDto, BulkBookDto, GenerateLoadsheetDto } from './dto/courier.dto';

// Valid Orders-board filters: order-state slices + any shipment status.
const QUEUE_STATUSES: readonly QueueStatus[] = [
  'unfulfilled',
  'fulfilled',
  'all',
  'archived',
  'booked',
  'in_transit',
  'out_for_delivery',
  'picked_up',
  'ready_for_pickup',
  'delivered',
  'attempted',
  'failed',
  'address_issue',
  'returned',
  'cancelled',
];
const asQueueStatus = (s?: string): QueueStatus | undefined =>
  s && (QUEUE_STATUSES as readonly string[]).includes(s)
    ? (s as QueueStatus)
    : undefined;

const COURIER_TYPES: readonly CourierType[] = ['trax', 'leopards', 'postex', 'rocket'];
const asCourierType = (c?: string): CourierType | undefined =>
  c && (COURIER_TYPES as readonly string[]).includes(c) ? (c as CourierType) : undefined;

@Controller('shipments')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class ShipmentsController {
  constructor(
    private readonly shipments: ShipmentService,
    private readonly tracking: ShipmentTrackingService,
    private readonly statusSync: CourierStatusSyncService,
    private readonly ops: CourierOpsService,
    private readonly loadsheets: LoadsheetService,
    private readonly cityMapping: CityMappingService,
  ) {}

  /**
   * Pull fresh statuses from the couriers for every non-terminal shipment
   * (background job). Fixes parcels stuck because courier→Shopify tracking
   * never synced. Owner/admin only.
   */
  @Post('sync-status')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  syncStatus(@CurrentUser() user: { companyId: number }) {
    return this.statusSync.requestSync(user.companyId);
  }

  @Get()
  list(
    @CurrentUser() user: { companyId: number },
    @Query('status') status?: ShipmentStatus,
    @Query('courierType') courierType?: CourierType,
    @Query('needsAttention') needsAttention?: string,
    @Query('loadsheetPending') loadsheetPending?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.shipments.listShipments(user.companyId, {
      status,
      courierType,
      needsAttention: needsAttention === 'true' || needsAttention === '1',
      loadsheetPending: loadsheetPending === 'true' || loadsheetPending === '1',
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** Courier pending payments summary — receivable COD + shipment count per courier. */
  @Get('pending-payments')
  pendingPayments(@CurrentUser() user: { companyId: number }) {
    return this.shipments.courierPendingPayments(user.companyId);
  }

  /** Drill-down list per bucket ('receivable' delivered COD, or 'transit'). */
  @Get('pending-payments/list')
  pendingPaymentsList(
    @CurrentUser() user: { companyId: number },
    @Query('courierType') courierType?: CourierType,
    @Query('bucket') bucket?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.shipments.listPendingPayments(user.companyId, {
      courierType,
      bucket: bucket === 'transit' ? 'transit' : 'receivable',
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** Mark courier COD as remitted/reconciled (by shipment ids or whole courier). */
  @Post('pending-payments/settle')
  settlePayments(
    @CurrentUser() user: { companyId: number },
    @Body() body: { shipmentIds?: number[]; courierType?: CourierType },
  ) {
    return this.shipments.settlePayments(user.companyId, {
      shipmentIds: body?.shipmentIds,
      courierType: body?.courierType,
    });
  }

  /** Prepaid payment summary — Bank Deposit + Card Payments cards. */
  @Get('prepaid-payments')
  prepaidPayments(@CurrentUser() user: { companyId: number }) {
    return this.shipments.prepaidPaymentSummary(user.companyId);
  }

  /** Drill-down list for a prepaid card ('bank' | 'card'). */
  @Get('prepaid-payments/list')
  prepaidPaymentsList(
    @CurrentUser() user: { companyId: number },
    @Query('bucket') bucket?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.shipments.listPrepaidPayments(user.companyId, {
      bucket: bucket === 'card' ? 'card' : 'bank',
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** Mark Card-Payments orders reconciled (by shipment ids or order numbers). */
  @Post('prepaid-payments/reconcile')
  reconcileCardPayments(
    @CurrentUser() user: { companyId: number },
    @Body() body: { shipmentIds?: number[]; orderNumbers?: string[] },
  ) {
    return this.shipments.reconcileCardPayments(user.companyId, {
      shipmentIds: body?.shipmentIds,
      orderNumbers: body?.orderNumbers,
    });
  }

  @Get('suggest-courier')
  suggestCourier(
    @CurrentUser() user: { companyId: number },
    @Query('city') city: string,
  ) {
    return this.shipments.listCouriersForCity(user.companyId, city || '');
  }

  /**
   * Type-ahead city suggestions for the address / create-order forms. Sourced
   * from the known courier cities (platform seed + tenant overrides), so it's
   * tenant-agnostic and always relevant to who can actually be booked. All
   * roles (agents create orders / correct addresses).
   */
  @Get('cities')
  searchCities(
    @CurrentUser() user: { companyId: number },
    @Query('query') query?: string,
  ) {
    return this.cityMapping.searchCities(user.companyId, query ?? '');
  }

  /** The fulfilment queue — unfulfilled Shopify orders from the local mirror. */
  @Get('queue')
  queue(
    @CurrentUser() user: { companyId: number },
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('includeFulfilled') includeFulfilled?: string,
    @Query('confirmation') confirmation?: string,
    @Query('courier') courier?: string,
  ) {
    return this.shipments.listFulfillmentQueue(user.companyId, {
      search,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      status: asQueueStatus(status),
      includeFulfilled: includeFulfilled === 'true',
      confirmation:
        confirmation === 'confirmed'
          ? 'confirmed'
          : confirmation === 'unconfirmed'
            ? 'unconfirmed'
            : undefined,
      courier: asCourierType(courier),
    });
  }

  /** Manually flag an order's address as wrong (→ address_issue, no booking). */
  @Post('mark-wrong-address')
  markWrongAddress(
    @CurrentUser() user: { companyId: number },
    @Body() body: { orderGid?: string; reason?: string; courierType?: CourierType },
  ) {
    return this.shipments.markWrongAddress(
      user.companyId,
      body?.orderGid ?? '',
      body?.reason,
      body?.courierType,
    );
  }

  /** Per-courier delivery performance over a date range (default last 30 days). */
  @Get('performance')
  performance(
    @CurrentUser() user: { companyId: number },
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const now = new Date();
    const parse = (v: string | undefined, fallback: Date) => {
      const d = v ? new Date(v) : null;
      return d && !Number.isNaN(d.getTime()) ? d : fallback;
    };
    const defFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return this.shipments.courierPerformance(
      user.companyId,
      parse(from, defFrom),
      parse(to, now),
    );
  }

  /** All order GIDs matching a queue filter — for "select all across pages". */
  @Get('queue/ids')
  queueIds(
    @CurrentUser() user: { companyId: number },
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('courier') courier?: string,
  ) {
    return this.shipments.listQueueIds(user.companyId, {
      search,
      status: asQueueStatus(status),
      courier: asCourierType(courier),
    });
  }

  @Post()
  book(
    @CurrentUser() user: { companyId: number; userId: number },
    @Body() dto: BookShipmentDto,
  ) {
    return this.shipments.bookShipment({
      companyId: user.companyId,
      shopifyOrderName: dto.shopifyOrderName,
      courierType: dto.courierType,
      overrideAddressIssue: dto.overrideAddressIssue,
      createdByUserId: user.userId,
    });
  }

  /** Bulk-book many selected orders at once (background fan-out). */
  @Post('bulk-book')
  bulkBook(
    @CurrentUser() user: { companyId: number; userId: number },
    @Body() dto: BulkBookDto,
  ) {
    return this.shipments.bulkBook(user.companyId, dto.orderGids ?? [], {
      courierType: dto.courierType,
      courierByGid: dto.courierByGid,
      createdByUserId: user.userId,
    });
  }

  /** Live progress for a bulk-book batch (polled by the client). POST so the
   *  order-GID list travels in the body; declared BEFORE :id so the static path
   *  isn't captured by the param route. */
  @Post('booking-progress')
  bookingProgress(
    @CurrentUser() user: { companyId: number },
    @Body() dto: { orderGids?: string[] },
  ) {
    return this.shipments.bookingProgress(user.companyId, dto.orderGids ?? []);
  }

  @Get(':id')
  get(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.shipments.getShipment(user.companyId, id);
  }

  /** Native tracking checkpoint history (for couriers whose portal can't be
   *  embedded — currently Leopards). `supported:false` → UI uses the iframe. */
  @Get(':id/tracking')
  trackingHistory(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.shipments.getTrackingHistory(user.companyId, id);
  }

  @Post(':id/resolve-address-issue')
  resolveAddressIssue(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.shipments.resolveAddressIssue(user.companyId, id);
  }

  @Post(':id/redeliver')
  redeliver(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.tracking.redeliver(user.companyId, id);
  }

  /** Send shipper advice on an attempted parcel (request re-attempt or return). */
  @Post(':id/shipper-advice')
  shipperAdvice(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { action?: string; remarks?: string },
  ) {
    const action = body?.action === 'return' ? 'return' : 'reattempt';
    return this.tracking.sendShipperAdvice(user.companyId, id, action, body?.remarks ?? '');
  }

  /** Cancel/undo a booking: cancel at courier + Shopify unfulfill + free order. */
  @Post(':id/cancel-booking')
  cancelBooking(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.ops.cancelBooking(user.companyId, id);
  }

  /** Printable shipping labels for the selected parcels (single courier). */
  @Post('labels')
  labels(
    @CurrentUser() user: { companyId: number },
    @Body() body: { shipmentIds?: number[] },
  ) {
    return this.ops.generateLabels(user.companyId, body?.shipmentIds ?? []);
  }

  /** ONE downloadable PDF of the courier's slips, 2 per A4 page (single courier,
   *  byte-label couriers only — Trax/PostEx/Rocket; Leopards excluded). */
  @Post('slips')
  slips(
    @CurrentUser() user: { companyId: number },
    @Body() body: { shipmentIds?: number[] },
  ) {
    return this.ops.generateSlipSheet(user.companyId, body?.shipmentIds ?? []);
  }

  /**
   * A returned parcel was physically received back (RTO). Blacklists the
   * customer + cancels & archives the order in Shopify. Destructive — the UI
   * confirms before calling.
   */
  @Post(':id/mark-received')
  markReceived(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.shipments.processReturn(user.companyId, id, 'manual');
  }

  /** Bulk RTO — mark many parcels received by shipment ids or order numbers. */
  @Post('bulk-receive')
  bulkReceive(
    @CurrentUser() user: { companyId: number },
    @Body() body: { shipmentIds?: number[]; orderNames?: string[] },
  ) {
    return this.shipments.bulkReceive(user.companyId, {
      shipmentIds: body?.shipmentIds,
      orderNames: body?.orderNames,
    });
  }

  @Get('loadsheets/list')
  listLoadsheets(@CurrentUser() user: { companyId: number }) {
    return this.loadsheets.listBatches(user.companyId);
  }

  @Post('loadsheets/generate')
  generateLoadsheet(
    @CurrentUser() user: { companyId: number; userId: number },
    @Body() dto: GenerateLoadsheetDto,
  ) {
    return this.loadsheets.generateLoadsheet(user.companyId, dto.courierType, user.userId);
  }

  /** Downloadable product pick sheet (aggregated line items) for one loadsheet. */
  @Get('loadsheets/:id/picklist')
  loadsheetPicklist(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.loadsheets.buildPicklist(user.companyId, id);
  }
}
