import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Edit a variant. Every field is optional (partial update). The CodesApp-only
 * fields (item_code/alias/…) never touch Shopify. A change to `local_qty`
 * triggers a push to Shopify (handled in the service). String fields accept
 * null/'' to clear.
 */
export class UpdateVariantDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(80)
  item_code?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(120)
  alias?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000000)
  reorder_level?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  cost_price?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(120)
  shelf_location?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(120)
  category?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(20000)
  notes?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000000)
  local_qty?: number;
}

export class StoreScopedDto {
  @IsOptional()
  @IsInt()
  storeId?: number;
}
