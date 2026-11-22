import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ModuleGuard } from '../../common/guards/module.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PRIVILEGED } from '../../common/auth/roles';
import { StockOpsService } from './stock-ops.service';

type CU = { companyId: number; userId: number; role: string };
/** Warehouse work (counts, transfers, receiving) is open to the floor team. */
const WAREHOUSE = [...PRIVILEGED, 'fulfillment', 'member'];
const isPriv = (u: CU) => u.role === 'owner' || u.role === 'admin';

class QtyLine {
  @IsInt() itemId!: number;
  @IsInt() @Min(0) @Max(1e7) qty!: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) unitCost?: number | null;
}

class CreateCountDto {
  @IsInt() locationId!: number;
  @IsOptional() @IsBoolean() blind?: boolean;
  @IsOptional() @IsString() @MaxLength(160) scope?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(2000) @IsInt({ each: true }) itemIds?: number[];
}
class ScanDto {
  @IsOptional() @IsString() @MaxLength(160) code?: string;
  @IsOptional() @IsInt() itemId?: number;
  @IsOptional() @IsInt() @Min(-10000) @Max(10000) qty?: number;
}
class CountLineDto {
  @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(1e7) counted!: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(24) reason?: string | null;
}
class TransferDto {
  @IsInt() fromLocationId!: number;
  @IsInt() toLocationId!: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => QtyLine) lines!: QtyLine[];
}
class SupplierDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(120) contactName?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(160) email?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500) address?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(5000) notes?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(365) leadTimeDays?: number | null;
  @IsOptional() @IsBoolean() archived?: boolean;
}
class PoDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() supplierId?: number | null;
  @IsOptional() @IsInt() locationId?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40) expectedAt?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(5000) notes?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) freight?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => QtyLine) lines?: QtyLine[];
}
class ReceiveDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => QtyLine) lines!: QtyLine[];
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999) freight?: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class PaymentDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(99_999_999) amount!: number;
}
class ImportApplyDto {
  @IsString() @MaxLength(64) token!: string;
}

@Controller('inventory')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard, ModuleGuard)
@RequireModule('inventory')
@Roles(...WAREHOUSE)
export class StockOpsController {
  constructor(private readonly ops: StockOpsService) {}

  @Get('stock-search')
  stockSearch(@CurrentUser() u: CU, @Query('q') q?: string) {
    return this.ops.stockSearch(u.companyId, q ?? '');
  }

  // ── counts ──
  @Get('counts')
  counts(@CurrentUser() u: CU) {
    return this.ops.listCounts(u.companyId);
  }
  @Post('counts')
  createCount(@CurrentUser() u: CU, @Body() dto: CreateCountDto) {
    return this.ops.createCount(u.companyId, dto, u.userId);
  }
  @Get('counts/:id')
  count(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.ops.getCount(u.companyId, id, isPriv(u));
  }
  @Post('counts/:id/scan')
  scan(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Body() dto: ScanDto) {
    return this.ops.scanCount(u.companyId, id, dto, isPriv(u));
  }
  @Patch('counts/:id/lines/:itemId')
  line(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Param('itemId', ParseIntPipe) itemId: number, @Body() dto: CountLineDto) {
    return this.ops.setCountLine(u.companyId, id, itemId, dto, isPriv(u));
  }
  @Post('counts/:id/apply')
  @Roles(...PRIVILEGED)
  applyCount(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.ops.applyCount(u.companyId, id, u.userId);
  }
  @Post('counts/:id/cancel')
  @Roles(...PRIVILEGED)
  cancelCount(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.ops.cancelCount(u.companyId, id);
  }

  // ── transfers ──
  @Get('transfers')
  transfers(@CurrentUser() u: CU) {
    return this.ops.listTransfers(u.companyId);
  }
  @Post('transfers')
  createTransfer(@CurrentUser() u: CU, @Body() dto: TransferDto) {
    return this.ops.createTransfer(u.companyId, dto, u.userId);
  }
  @Get('transfers/:id')
  transfer(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.ops.getTransfer(u.companyId, id);
  }
  @Post('transfers/:id/send')
  sendTransfer(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.ops.sendTransfer(u.companyId, id, u.userId);
  }
  @Post('transfers/:id/receive')
  receiveTransfer(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.ops.receiveTransfer(u.companyId, id, u.userId);
  }
  @Post('transfers/:id/cancel')
  cancelTransfer(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.ops.cancelTransfer(u.companyId, id, u.userId);
  }

  // ── import ──
  @Post('import/preview')
  @Roles(...PRIVILEGED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  preview(
    @CurrentUser() u: CU,
    @UploadedFile() file: { buffer?: Buffer } | undefined,
    @Body('locationId') locationId: string,
    @Body('mode') mode: string,
  ) {
    if (!file?.buffer) throw new BadRequestException('Attach a CSV file');
    const loc = Number(locationId);
    if (!Number.isInteger(loc)) throw new BadRequestException('Pick a location');
    return this.ops.previewImport(u.companyId, file.buffer, { locationId: loc, mode: mode === 'adjust' ? 'adjust' : 'set' });
  }
  @Post('import/apply')
  @Roles(...PRIVILEGED)
  applyImport(@CurrentUser() u: CU, @Body() dto: ImportApplyDto) {
    return this.ops.applyImport(u.companyId, dto.token, u.userId);
  }

  // ── suppliers ──
  @Get('suppliers')
  @Roles(...PRIVILEGED)
  suppliers(@CurrentUser() u: CU, @Query('q') q?: string) {
    return this.ops.listSuppliers(u.companyId, q);
  }
  @Post('suppliers')
  @Roles(...PRIVILEGED)
  createSupplier(@CurrentUser() u: CU, @Body() dto: SupplierDto) {
    return this.ops.saveSupplier(u.companyId, null, dto);
  }
  @Patch('suppliers/:id')
  @Roles(...PRIVILEGED)
  updateSupplier(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Body() dto: SupplierDto) {
    return this.ops.saveSupplier(u.companyId, id, dto);
  }

  // ── purchase orders ──
  @Get('reorder-suggestions')
  @Roles(...PRIVILEGED)
  suggestions(@CurrentUser() u: CU, @Query('supplierId') supplierId?: string, @Query('locationId') locationId?: string) {
    return this.ops.reorderSuggestions(u.companyId, { supplierId: Number(supplierId) || undefined, locationId: Number(locationId) || undefined });
  }
  @Get('purchase-orders')
  pos(@CurrentUser() u: CU, @Query('status') status?: string, @Query('q') q?: string) {
    return this.ops.listPOs(u.companyId, { status: status && ['open', 'draft', 'sent', 'partial', 'received', 'closed', 'cancelled'].includes(status) ? status : undefined, q });
  }
  @Post('purchase-orders')
  @Roles(...PRIVILEGED)
  createPO(@CurrentUser() u: CU, @Body() dto: PoDto) {
    if (!dto.locationId) throw new BadRequestException('Pick where the stock goes');
    return this.ops.createPO(u.companyId, { ...dto, locationId: dto.locationId, lines: dto.lines ?? [] }, u.userId);
  }
  @Get('purchase-orders/:id')
  po(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.ops.getPO(u.companyId, id);
  }
  @Patch('purchase-orders/:id')
  @Roles(...PRIVILEGED)
  updatePO(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Body() dto: PoDto) {
    return this.ops.updatePO(u.companyId, id, dto);
  }
  @Post('purchase-orders/:id/send')
  @Roles(...PRIVILEGED)
  sendPO(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.ops.sendPO(u.companyId, id);
  }
  @Post('purchase-orders/:id/receive')
  receivePO(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Body() dto: ReceiveDto) {
    return this.ops.receivePO(u.companyId, id, dto, u.userId);
  }
  @Post('purchase-orders/:id/cancel')
  @Roles(...PRIVILEGED)
  cancelPO(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.ops.cancelPO(u.companyId, id);
  }
  @Post('purchase-orders/:id/payment')
  @Roles(...PRIVILEGED)
  payment(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Body() dto: PaymentDto) {
    return this.ops.recordPayment(u.companyId, id, dto.amount);
  }
}

