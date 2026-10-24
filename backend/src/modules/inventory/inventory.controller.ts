import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { InventoryService } from './inventory.service';
import { StoreScopedDto, UpdateVariantDto } from './dto/inventory.dto';

type CU = { companyId: number; userId: number; role: string };

// The Inventory board + management is owner/admin (class gate). The `lookup`
// route (consumed by the inbox create-order modal) is widened to agents so they
// can add a product by its CodesApp item code when placing an order.
const MANAGE_ROLES = ['owner', 'admin'];
const LOOKUP_ROLES = ['owner', 'admin', 'agent'];

const toInt = (v?: string): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

@Controller('inventory')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles(...MANAGE_ROLES)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  // ── Static routes FIRST (so "stats" / "lookup" aren't parsed as an :id) ──

  @Get()
  async list(
    @CurrentUser() user: CU,
    @Query('storeId') storeId?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    await this.inventory.assertEnabled(user.companyId);
    return this.inventory.list(user.companyId, {
      storeId: toInt(storeId),
      search,
      status,
      category,
      page: toInt(page),
      limit: toInt(limit),
    });
  }

  @Get('stats')
  async stats(@CurrentUser() user: CU, @Query('storeId') storeId?: string) {
    await this.inventory.assertEnabled(user.companyId);
    return this.inventory.stats(user.companyId, toInt(storeId));
  }

  @Get('categories')
  async categories(@CurrentUser() user: CU, @Query('storeId') storeId?: string) {
    await this.inventory.assertEnabled(user.companyId);
    return this.inventory.categories(user.companyId, toInt(storeId));
  }

  @Get('lookup')
  @UseGuards(RolesGuard)
  @Roles(...LOOKUP_ROLES)
  async lookup(
    @CurrentUser() user: CU,
    @Query('q') q: string,
    @Query('storeId') storeId?: string,
  ) {
    await this.inventory.assertEnabled(user.companyId);
    return this.inventory.lookup(user.companyId, q ?? '', toInt(storeId));
  }

  @Get('sync-status')
  async syncStatus(@CurrentUser() user: CU, @Query('storeId') storeId?: string) {
    await this.inventory.assertEnabled(user.companyId);
    return this.inventory.syncStatus(user.companyId, toInt(storeId));
  }

  @Get('export')
  async export(@CurrentUser() user: CU, @Query('storeId') storeId?: string) {
    await this.inventory.assertEnabled(user.companyId);
    const csv = await this.inventory.exportCsv(user.companyId, toInt(storeId));
    return { filename: `inventory-${Date.now()}.csv`, csv };
  }

  @Post('sync')
  async sync(@CurrentUser() user: CU, @Body() dto: StoreScopedDto) {
    await this.inventory.assertEnabled(user.companyId);
    return this.inventory.requestSync(user.companyId, dto.storeId);
  }

  @Post('push-changed')
  async pushChanged(@CurrentUser() user: CU, @Body() dto: StoreScopedDto) {
    await this.inventory.assertEnabled(user.companyId);
    return this.inventory.pushChanged(user.companyId, dto.storeId);
  }

  // ── Param routes LAST ──

  @Get('variants/:id')
  async getVariant(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.inventory.assertEnabled(user.companyId);
    return this.inventory.getVariant(user.companyId, id);
  }

  @Patch('variants/:id')
  async updateVariant(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateVariantDto,
  ) {
    await this.inventory.assertEnabled(user.companyId);
    return this.inventory.updateVariant(user.companyId, id, dto, user.userId);
  }

  @Post('variants/:id/push')
  async pushVariant(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.inventory.assertEnabled(user.companyId);
    return this.inventory.pushVariant(user.companyId, id);
  }
}
