import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Structured delivery address (matches the required address fields). */
export class PrAddressDto {
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsString() @MinLength(1) @MaxLength(40) number!: string;
  @IsString() @MinLength(1) @MaxLength(160) house!: string;
  @IsString() @MinLength(1) @MaxLength(200) street!: string;
  @IsOptional() @IsString() @MaxLength(200) landmark?: string;
  @IsString() @MinLength(1) @MaxLength(120) city!: string;
}

/** Influencer-submitted data on the public form (redesigned questionnaire). */
export class PublicPrSubmitDto {
  @IsString() @MinLength(1) @MaxLength(160) influencerName!: string;
  @IsString() @MinLength(3) @MaxLength(255) email!: string;
  @IsString() @MinLength(5) @MaxLength(40) phone!: string;
  @IsString() @MinLength(2) @MaxLength(255) instagram!: string;

  @IsOptional() @IsString() @MaxLength(255) tiktok?: string;

  // Followers as typed (e.g. "25K") + a parsed numeric when possible.
  @IsString() @MinLength(1) @MaxLength(40) followersText!: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000000000) followerCount?: number;

  @IsIn(['Male', 'Female', 'Kids']) category!: string;

  @IsString() @MinLength(1) @MaxLength(2000) about!: string;

  @IsArray()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  videoTypes!: string[];

  @IsString() @MinLength(1) @MaxLength(2000) whyCollaborate!: string;
  @IsString() @MinLength(1) @MaxLength(2000) contentPlan!: string;

  @IsIn(['2', '3']) videosCount!: string;

  @IsOptional() @IsString() @MaxLength(300) productPreference?: string;

  @ValidateNested() @Type(() => PrAddressDto) address!: PrAddressDto;

  @IsBoolean() adsConsent!: boolean;
  @IsBoolean() termsConsent!: boolean;
}
