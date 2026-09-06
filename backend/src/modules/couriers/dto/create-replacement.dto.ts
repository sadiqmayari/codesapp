import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CourierType } from '@prisma/client';

/**
 * Book a replacement parcel for a support ticket on the chosen courier. A
 * replacement is a NEW outbound shipment (usually COD 0) for an order whose
 * original parcel was returned / damaged / wrong — persisted as a real shipment
 * row linked back to the ticket (see ReplacementShipmentService).
 *
 * Sent as multipart/form-data (an optional return-item photo rides along), so
 * numeric fields arrive as strings and are coerced via @Type(() => Number).
 */
export class CreateReplacementDto {
  @Type(() => Number)
  @IsInt()
  ticketId!: number;

  @IsEnum(CourierType)
  courierType!: CourierType;

  @IsString()
  @MaxLength(255)
  name!: string;

  @IsString()
  @MaxLength(64)
  phone!: string;

  @IsString()
  @MaxLength(128)
  city!: string;

  @IsString()
  @MaxLength(500)
  address1!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address2?: string;

  /** The item being SENT to the customer (delivered leg). */
  @IsString()
  @MaxLength(500)
  contents!: string;

  /** COD to collect on the replacement — 0 for a free re-send, or the price
   *  difference for an exchange. */
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  codAmount!: number;

  @IsOptional()
  @IsEmail()
  email?: string;

  // ── Item being TAKEN BACK (Trax replacement leg; PostEx ignores these) ──
  @IsOptional()
  @IsString()
  @MaxLength(500)
  returnItemDescription?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  returnItemQuantity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  returnItemProductTypeId?: number;
}
