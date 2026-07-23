import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
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

// A manual discount — percentage (0–100) or a fixed amount in store currency.
export class OrderDiscountDto {
  @IsIn(['percentage', 'fixed'])
  type!: 'percentage' | 'fixed';

  @IsNumber()
  @Min(0)
  value!: number;
}

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

  // Optional per-line manual discount.
  @IsOptional()
  @ValidateNested()
  @Type(() => OrderDiscountDto)
  discount?: OrderDiscountDto;
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

  // Optional order-level manual discount (applied to the whole order).
  @IsOptional()
  @ValidateNested()
  @Type(() => OrderDiscountDto)
  orderDiscount?: OrderDiscountDto;

  // A Shopify Customer GID to link the order to (from search/create).
  @IsOptional()
  @IsString()
  @MaxLength(255)
  customerId?: string;

  // Where this order was created from, for separated analytics.
  // 'abandoned_cart' = the Abandoned Checkouts "Create order" button;
  // otherwise treated as a regular inbox order.
  @IsOptional()
  @IsIn(['abandoned_cart', 'inbox'])
  source?: 'abandoned_cart' | 'inbox';
}

// POST /shopify/customers — create a customer (after a search found none).
export class CreateCustomerDto {
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

  @IsOptional()
  @IsString()
  @Length(2, 2)
  countryCode?: string;
}
