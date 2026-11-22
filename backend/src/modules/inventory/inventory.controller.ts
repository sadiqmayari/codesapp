import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Response } from 'express';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ModuleGuard } from '../../common/guards/module.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { INBOX_ROLES, PRIVILEGED } from '../../common/auth/roles';
import { InventoryService, ItemFilters } from './inventory.service';
import {
  AdjustDto,
  AvailabilityDto,
  BulkDto,
  InventorySettingsDto,
  LinkListingDto,
  LinkUpdateDto,
  LocationDto,
  ResolveConflictDto,
  SetAvailableDto,
  StoreScopedDto,
  UpdateItemDto,
  UpdateListingDto,
} from './dto/inventory.dto';

type CU = { companyId: number; userId: number; role: string };

/** Selling surfaces (create-order modal, item editor) read stock too. */
const SELL_ROLES = [...INBOX_ROLES, 'fulfillment'];

const toInt = (v?: string): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
};

const filtersOf = (q: Record<string, string | undefined>): ItemFilters => ({
  storeId: toInt(q.storeId),
  locationId: toInt(q.locationId),
  search: q.search,
  status: q.status,
  category: q.category,
  page: toInt(q.page),
  limit: toInt(q.limit),
  sort: q.sort,
  dir: q.dir,
});

@Controller('inventory')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard, ModuleGuard)
@RequireModule('inventory')
@Roles(...PRIVILEGED)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  // ── Static routes FIRST ──

  @Get('items')
  list(@CurrentUser() u: CU, @Query() q: Record<string, string>) {
    return this.inventory.list(u.companyId, filtersOf(q));
  }

  @Get('summary')
  summary(@CurrentUser() u: CU, @Query('storeId') storeId?: string, @Query('locationId') locationId?: string) {
    return this.inventory.summary(u.companyId, toInt(storeId), toInt(locationId));
  }

  @Get('categories')
  categories(@CurrentUser() u: CU) {
    return this.inventory.categories(u.companyId);
  }

  @Get('conflicts')
  conflicts(@CurrentUser() u: CU) {
    return this.inventory.conflicts(u.companyId);
  }

  @Post('conflicts/resolve')
  resolve(@CurrentUser() u: CU, @Body() dto: ResolveConflictDto) {
    return this.inventory.resolveConflict(u.companyId, dto, u.userId);
  }

  @Post('bulk')
  bulk(@CurrentUser() u: CU, @Body() dto: BulkDto) {
    return this.inventory.bulk(u.companyId, dto, u.userId);
  }

  @Get('ledger')
  ledger(@CurrentUser() u: CU, @Query() q: Record<string, string>) {
    return this.inventory.movements(u.companyId, {
      itemId: toInt(q.itemId), locationId: toInt(q.locationId), reason: q.reason, from: q.from, to: q.to,
      page: toInt(q.page), limit: toInt(q.limit),
    });
  }

  @Get('ledger/export')
  async ledgerExport(@CurrentUser() u: CU, @Query() q: Record<string, string>, @Res() res: Response) {
    const csv = await this.inventory.exportMovements(u.companyId, {
      itemId: toInt(q.itemId), locationId: toInt(q.locationId), reason: q.reason, from: q.from, to: q.to,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="stock-ledger.csv"');
    res.send(csv);
  }

  @Get('export')
  async export(@CurrentUser() u: CU, @Query() q: Record<string, string>, @Res() res: Response) {
    const csv = await this.inventory.exportItems(u.companyId, filtersOf(q));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');
    res.send(csv);
  }

  @Get('locations')
  locations(@CurrentUser() u: CU) {
    return this.inventory.locations(u.companyId);
  }

  @Post('locations')
  createLocation(@CurrentUser() u: CU, @Body() dto: LocationDto) {
    return this.inventory.saveLocation(u.companyId, null, dto);
  }

  @Patch('locations/:id')
  updateLocation(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Body() dto: LocationDto) {
    return this.inventory.saveLocation(u.companyId, id, dto);
  }

  @Patch('location-links/:id')
  updateLink(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Body() dto: LinkUpdateDto) {
    return this.inventory.updateLink(u.companyId, id, dto);
  }

  @Post('sync')
  sync(@CurrentUser() u: CU, @Body() dto: StoreScopedDto) {
    return this.inventory.requestSync(u.companyId, dto.storeId);
  }

  @Get('sync-status')
  syncStatus(@CurrentUser() u: CU) {
    return this.inventory.syncStatus(u.companyId);
  }

  @Get('settings')
  settings(@CurrentUser() u: CU) {
    return this.inventory.settings(u.companyId);
  }

  @Patch('settings')
  saveSettings(@CurrentUser() u: CU, @Body() dto: InventorySettingsDto) {
    return this.inventory.saveSettings(u.companyId, dto as Record<string, unknown>);
  }

  /** Stock for selling surfaces (agents/fulfilment too). */
  @Post('availability')
  @Roles(...SELL_ROLES)
  availability(@CurrentUser() u: CU, @Body() dto: AvailabilityDto) {
    return this.inventory.availability(u.companyId, dto);
  }

  @Get('lookup')
  @Roles(...SELL_ROLES)
  lookup(@CurrentUser() u: CU, @Query('q') q?: string, @Query('storeId') storeId?: string) {
    return this.inventory.availability(u.companyId, { q, storeId: toInt(storeId) }).then((r) => r.items);
  }

  // ── Param routes LAST ──

  @Get('variants/:id/item')
  itemForVariant(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.inventory.itemForVariant(u.companyId, id);
  }

  @Patch('listings/:id')
  updateListing(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateListingDto) {
    return this.inventory.updateListing(u.companyId, id, dto);
  }

  @Delete('listings/:id/link')
  unlink(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.inventory.unlinkListing(u.companyId, id);
  }

  @Get('items/:id')
  getItem(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.inventory.getItem(u.companyId, id);
  }

  @Patch('items/:id')
  updateItem(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateItemDto) {
    return this.inventory.updateItem(u.companyId, id, dto, u.userId);
  }

  @Post('items/:id/adjust')
  adjust(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Body() dto: AdjustDto) {
    return this.inventory.adjust(u.companyId, id, dto, u.userId);
  }

  @Post('items/:id/set')
  set(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Body() dto: SetAvailableDto) {
    return this.inventory.setAvailable(u.companyId, id, dto, u.userId);
  }

  @Post('items/:id/push')
  push(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.inventory.pushNow(u.companyId, id);
  }

  @Get('items/:id/link-candidates')
  candidates(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Query('q') q?: string) {
    return this.inventory.linkCandidates(u.companyId, id, q);
  }

  @Post('items/:id/link')
  link(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Body() dto: LinkListingDto) {
    return this.inventory.linkListing(u.companyId, id, dto.listingId);
  }
}
