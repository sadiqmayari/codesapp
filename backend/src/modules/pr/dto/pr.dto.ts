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
  @MaxLength(80)
  slug?: string;

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
  @MaxLength(80)
  slug?: string;

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

export class SetOutcomeDto {
  @IsIn(['pending', 'posted', 'no_show'])
  outcome!: 'pending' | 'posted' | 'no_show';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  postUrl?: string;
}

export class UpdateInfluencerDto {
  @IsOptional() @IsString() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(255) email?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(1000) address?: string;
  @IsOptional() @IsString() @MaxLength(160) instagram?: string;
  @IsOptional() @IsString() @MaxLength(160) tiktok?: string;
  @IsOptional() @IsString() @MaxLength(255) other_social?: string;
  @IsOptional() @IsInt() @Min(0) follower_count?: number;
  @IsOptional() @IsString() @MaxLength(120) niche?: string;
  @IsOptional() @IsIn(['active', 'vip', 'blacklisted']) status?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  @IsOptional() @IsArray() tags?: string[];
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
