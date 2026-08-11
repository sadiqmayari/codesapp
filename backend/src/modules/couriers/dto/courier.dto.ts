import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { COURIER_TYPES } from '../courier-registry.service';

export class BookShipmentDto {
  @IsString()
  shopifyOrderName!: string;

  @IsOptional()
  @IsIn(COURIER_TYPES)
  courierType?: (typeof COURIER_TYPES)[number];

  @IsOptional()
  overrideAddressIssue?: boolean;
}

export class BulkBookDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  orderGids!: string[];

  // Optional courier override applied to ALL selected orders; omitted = each
  // order uses its per-order override (courierByGid) or its city-suggested courier.
  @IsOptional()
  @IsIn(COURIER_TYPES)
  courierType?: (typeof COURIER_TYPES)[number];

  // Per-order courier overrides (orderGid → courier) — the per-row picker on the
  // board. Used only when `courierType` (the batch-wide override) is absent.
  @IsOptional()
  @IsObject()
  courierByGid?: Record<string, (typeof COURIER_TYPES)[number]>;
}

export class SetCourierCredentialsDto {
  @IsObject()
  credentials!: Record<string, string>;

  @IsOptional()
  @IsString()
  webhookSecret?: string;
}

export class UpsertCityMappingDto {
  @IsIn(COURIER_TYPES)
  courierType!: (typeof COURIER_TYPES)[number];

  @IsString()
  cityName!: string;

  @IsString()
  cityCode!: string;

  @IsOptional()
  isDefaultCourier?: boolean;
}

export class GenerateLoadsheetDto {
  @IsIn(COURIER_TYPES)
  courierType!: (typeof COURIER_TYPES)[number];
}

export class BulkSetDefaultCourierDto {
  @IsIn(COURIER_TYPES)
  courierType!: (typeof COURIER_TYPES)[number];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @IsString({ each: true })
  cities!: string[];
}

export class ClearDefaultCourierDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @IsString({ each: true })
  cities!: string[];
}
