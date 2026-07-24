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
  // order uses its own city-suggested courier.
  @IsOptional()
  @IsIn(COURIER_TYPES)
  courierType?: (typeof COURIER_TYPES)[number];
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
