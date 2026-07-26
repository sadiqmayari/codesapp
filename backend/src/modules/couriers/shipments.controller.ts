import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CourierType, ShipmentStatus } from '@prisma/client';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ShipmentService } from './shipment.service';
import { ShipmentTrackingService } from './shipment-tracking.service';
import { LoadsheetService } from './loadsheet.service';
import { BookShipmentDto, BulkBookDto, GenerateLoadsheetDto } from './dto/courier.dto';

@Controller('shipments')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class ShipmentsController {
  constructor(
    private readonly shipments: ShipmentService,
    private readonly tracking: ShipmentTrackingService,
    private readonly loadsheets: LoadsheetService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: { companyId: number },
    @Query('status') status?: ShipmentStatus,
    @Query('courierType') courierType?: CourierType,
    @Query('needsAttention') needsAttention?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.shipments.listShipments(user.companyId, {
      status,
      courierType,
      needsAttention: needsAttention === 'true' || needsAttention === '1',
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('suggest-courier')
  suggestCourier(
    @CurrentUser() user: { companyId: number },
    @Query('city') city: string,
  ) {
    return this.shipments.listCouriersForCity(user.companyId, city || '');
  }

  /** The fulfilment queue — unfulfilled Shopify orders from the local mirror. */
  @Get('queue')
  queue(
    @CurrentUser() user: { companyId: number },
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: 'unfulfilled' | 'fulfilled' | 'all' | 'archived',
    @Query('includeFulfilled') includeFulfilled?: string,
  ) {
    return this.shipments.listFulfillmentQueue(user.companyId, {
      search,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      status:
        status === 'fulfilled' ||
        status === 'all' ||
        status === 'unfulfilled' ||
        status === 'archived'
          ? status
          : undefined,
      includeFulfilled: includeFulfilled === 'true',
    });
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
    @Query('status') status?: 'unfulfilled' | 'fulfilled' | 'all' | 'archived',
  ) {
    return this.shipments.listQueueIds(user.companyId, {
      search,
      status:
        status === 'fulfilled' ||
        status === 'all' ||
        status === 'unfulfilled' ||
        status === 'archived'
          ? status
          : undefined,
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
      createdByUserId: user.userId,
    });
  }

  @Get(':id')
  get(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.shipments.getShipment(user.companyId, id);
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
}
