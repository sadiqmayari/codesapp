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
import { CourierType } from '@prisma/client';

/**
 * Book a replacement parcel for a support ticket on the chosen courier. A
 * replacement is a NEW outbound shipment (usually COD 0) for an order whose
 * original parcel was returned / damaged / wrong — persisted as a real shipment
 * row linked back to the ticket (see ReplacementShipmentService).
 */
export class CreateReplacementDto {
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

  @IsString()
  @MaxLength(500)
  contents!: string;

  /** COD to collect on the replacement — 0 for a free re-send, or the price
   *  difference for an exchange. */
  @IsNumber()
  @Min(0)
  codAmount!: number;

  @IsOptional()
  @IsEmail()
  email?: string;
}
