import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Influencer-submitted data on the public token-gated form. */
export class PublicPrSubmitDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  influencerName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  instagram?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  tiktok?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000000)
  followerCount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  productWishlist?: string;
}
