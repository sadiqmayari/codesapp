import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ModuleGuard } from '../../common/guards/module.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PRIVILEGED } from '../../common/auth/roles';
import { PRODUCT_STATUSES, ProductService, type ProductStatus } from './product.service';

type CU = { companyId: number; userId: number; role: string };
const MONEY = 99_999_999;

class OptionDto {
  @IsString() @MaxLength(60) name!: string;
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(80, { each: true }) values!: string[];
}
class VariantDto {
  @IsArray() @ArrayMaxSize(3) @IsString({ each: true }) optionValues!: string[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(160) sku?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(160) barcode?: string | null;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(MONEY) price!: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY) compareAt?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY) cost?: number | null;
  @IsOptional() @IsObject() stock?: Record<string, number>;
}
class StoreDto {
  @IsInt() storeId!: number;
  @IsIn(PRODUCT_STATUSES) status!: ProductStatus;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(-MONEY) @Max(MONEY) priceDelta?: number | null;
}
class CreateProductDto {
  @IsString() @MaxLength(255) title!: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(60000) descriptionHtml?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(255) productType?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(255) vendor?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) tags?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) images?: string[];
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() supplierId?: number | null;
  @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => OptionDto) options!: OptionDto[];
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => VariantDto) variants!: VariantDto[];
  @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => StoreDto) stores!: StoreDto[];
}
class StatusDto {
  @IsOptional() @IsArray() @ArrayMaxSize(2000) @IsInt({ each: true }) productIds?: number[];
  @IsOptional() @IsArray() @ArrayMaxSize(2000) @IsInt({ each: true }) itemIds?: number[];
  @IsOptional() @IsInt() storeId?: number;
  @IsIn(PRODUCT_STATUSES) status!: ProductStatus;
}
class DetailsDto {
  @IsString() @MaxLength(255) title!: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(60000) descriptionHtml?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(255) productType?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(255) vendor?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) tags?: string[];
}
class DescribeDto {
  @IsString() @MaxLength(255) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsString() @MaxLength(255) productType?: string;
  @IsOptional() @IsString() @MaxLength(500) options?: string;
}

@Controller('inventory/products')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard, ModuleGuard)
@RequireModule('inventory')
@Roles(...PRIVILEGED)
export class ProductController {
  constructor(private readonly products: ProductService) {}

  @Post()
  create(@CurrentUser() u: CU, @Body() dto: CreateProductDto) {
    return this.products.create(u.companyId, dto, u.userId);
  }

  @Get('jobs')
  jobs(@CurrentUser() u: CU, @Query('batch') batch?: string) {
    if (!batch) throw new BadRequestException('batch is required');
    return this.products.jobs(u.companyId, batch);
  }

  @Post('jobs/:id/retry')
  retry(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.products.retryJob(u.companyId, id);
  }

  @Post('status/preview')
  async preview(@CurrentUser() u: CU, @Body() dto: StatusDto) {
    const ids = dto.productIds?.length ? dto.productIds : await this.products.productIdsForItems(u.companyId, dto.itemIds ?? [], dto.storeId);
    return this.products.statusPreview(u.companyId, ids, dto.status);
  }

  @Post('status')
  async status(@CurrentUser() u: CU, @Body() dto: StatusDto) {
    const ids = dto.productIds?.length ? dto.productIds : await this.products.productIdsForItems(u.companyId, dto.itemIds ?? [], dto.storeId);
    return this.products.setStatus(u.companyId, ids, dto.status);
  }

  @Post('images')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  image(@CurrentUser() u: CU, @UploadedFile() file: { buffer?: Buffer; mimetype?: string; originalname?: string }) {
    return this.products.uploadImage(u.companyId, file);
  }

  @Post('describe')
  describe(@CurrentUser() u: CU, @Body() dto: DescribeDto) {
    return this.products.describe(u.companyId, u.userId, dto);
  }

  @Get(':id')
  get(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number) {
    return this.products.getProduct(u.companyId, id);
  }

  @Patch(':id')
  update(@CurrentUser() u: CU, @Param('id', ParseIntPipe) id: number, @Body() dto: DetailsDto) {
    return this.products.updateDetails(u.companyId, id, dto, u.userId);
  }
}
