import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreatePrCampaignDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  intro?: string;
}

export class UpdatePrCampaignDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  intro?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class DecideSubmissionDto {
  @IsIn(['approved', 'declined'])
  decision!: 'approved' | 'declined';
}

class PrLineItemDto {
  @IsString()
  @MaxLength(64)
  variantId!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

export class SendPackageDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PrLineItemDto)
  lineItems!: PrLineItemDto[];

  // Optional per-send overrides (default to the submission's values).
  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string;

  @IsOptional()
  @IsInt()
  storeId?: number;
}
