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
  ) {
    return this.shipments.listShipments(user.companyId, { status, courierType });
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
    @Query('includeFulfilled') includeFulfilled?: string,
  ) {
    return this.shipments.listFulfillmentQueue(user.companyId, {
      search,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      includeFulfilled: includeFulfilled === 'true',
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
