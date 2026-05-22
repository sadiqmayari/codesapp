import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateOrderLineItemDto {
  // A Shopify ProductVariant GID (preferred — price comes from the store).
  @IsOptional()
  @IsString()
  @MaxLength(255)
  variantId?: string;

  // Custom (non-catalog) fallback when no variantId is given.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsInt()
  @Min(1)
  @Max(10000)
  quantity!: number;

  // Only used for the custom fallback line.
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;
}

export class ShippingLineDto {
  @IsString()
  @MaxLength(255)
  title!: string;

  @IsNumber()
  @Min(0)
  price!: number;
}

// Body for POST /shopify/shipping-rates — the cart + destination Shopify
// needs to compute its store shipping rates against.
export class ShippingRatesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderLineItemDto)
  lineItems!: CreateOrderLineItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  customerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  countryCode?: string;
}

export class CreateShopifyOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderLineItemDto)
  lineItems!: CreateOrderLineItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(255)
  customerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  address1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  // ISO 3166-1 alpha-2 (e.g. "PK", "US").
  @IsOptional()
  @IsString()
  @Length(2, 2)
  countryCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  tags?: string[];

  // true → prepaid (order marked paid); false/undefined → COD (payment pending).
  @IsOptional()
  @IsBoolean()
  prepaid?: boolean;

  // A shipping rate the agent picked from POST /shopify/shipping-rates.
  @IsOptional()
  @ValidateNested()
  @Type(() => ShippingLineDto)
  shippingLine?: ShippingLineDto;
}
