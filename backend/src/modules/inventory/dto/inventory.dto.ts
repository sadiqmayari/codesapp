import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const MONEY_MAX = 99_999_999;

export class StoreScopedDto {
  @IsOptional()
  @IsInt()
  storeId?: number;
}

/** Edit a master item's CodesApp fields (partial). Strings accept null/'' to clear. */
export class UpdateItemDto {
  @IsOptional() @IsString() @MaxLength(400) title?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(80) item_code?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(120) alias?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(120) category?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(120) shelf_location?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(20000) notes?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(1e8) reorder_level?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) @Max(1e8) reorder_qty?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(365) lead_time_days?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) avg_cost?: number | null;
  @IsOptional() @IsBoolean() track?: boolean;
  @IsOptional() @IsBoolean() allow_backorder?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() supplier_id?: number | null;
}

export class AdjustDto {
  @IsInt() locationId!: number;
  @IsInt() @Min(-1e7) @Max(1e7) delta!: number;
  @IsString() @MaxLength(24) reason!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class SetAvailableDto {
  @IsOptional() @IsInt() locationId?: number;
  @IsInt() @Min(0) @Max(1e8) available!: number;
  /** the value the person saw — 409 if the stock moved since */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() seen?: number | null;
}

export class UpdateListingDto {
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(MONEY_MAX) price?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) compare_at_price?: number | null;
}

export class LinkListingDto {
  @IsInt() listingId!: number;
}

export class ResolveConflictDto {
  @IsInt() itemId!: number;
  @IsInt() locationId!: number;
  @IsInt() @Min(0) @Max(1e8) available!: number;
}

export class BulkDto {
  @IsArray() @ArrayMaxSize(2000) @IsInt({ each: true }) itemIds!: number[];
  @IsIn(['adjust', 'category', 'reorder', 'track', 'push']) action!: string;
  @IsOptional() @IsInt() locationId?: number;
  @IsOptional() @IsInt() @Min(-1e7) @Max(1e7) delta?: number;
  @IsOptional() @IsString() @MaxLength(24) reason?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(120) category?: string | null;
  @IsOptional() @IsInt() @Min(0) @Max(1e8) reorderLevel?: number;
  @IsOptional() @IsBoolean() track?: boolean;
}

export class LocationDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(500) address?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class LinkUpdateDto {
  @IsOptional() @IsInt() locationId?: number;
  @IsOptional() @IsBoolean() syncEnabled?: boolean;
}

export class InventorySettingsDto {
  @IsOptional() @IsBoolean() allowBackorder?: boolean;
  @IsOptional() @IsBoolean() warnOverAvailable?: boolean;
  @IsOptional() @IsBoolean() lowStockAlerts?: boolean;
  @IsOptional() @IsBoolean() dailyDigest?: boolean;
  @IsOptional() @IsBoolean() adsOutOfStockAlert?: boolean;
  @IsOptional() @IsBoolean() backInStockOffer?: boolean;
  @IsOptional() @IsBoolean() restockReturns?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) targetCoverDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(180) defaultLeadTimeDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(7) @Max(365) countCadenceDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(30) @Max(1440) reconcileMinutes?: number;
}

export class AvailabilityDto {
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) variantGids?: string[];
  @IsOptional() @IsInt() storeId?: number;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

export class WaitlistDto {
  @IsOptional() @IsString() @MaxLength(160) variantGid?: string;
  @IsOptional() @IsInt() itemId?: number;
  @IsOptional() @IsInt() conversationId?: number;
  @IsOptional() @IsInt() contactId?: number;
}
