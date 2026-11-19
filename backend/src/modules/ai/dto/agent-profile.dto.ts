import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { INDUSTRIES } from '../agent/packs';

/** PATCH /api/ai/agent/profile — every field optional (partial save). The JSON
 *  blobs (skills / handoff / hours) are normalised by resolveProfile. */
export class UpdateAgentProfileDto {
  @IsOptional() @IsIn(INDUSTRIES) industry?: string;
  @IsOptional() @IsString() @MaxLength(80) agentName?: string;
  @IsOptional() @IsString() @MaxLength(120) agentRole?: string;
  @IsOptional() @IsString() @MaxLength(4000) goals?: string;
  @IsOptional() @IsString() @MaxLength(4000) doRules?: string;
  @IsOptional() @IsString() @MaxLength(4000) dontRules?: string;
  @IsOptional() @IsString() @MaxLength(2000) tone?: string;
  @IsOptional() @IsString() @MaxLength(2) countryCode?: string;
  @IsOptional() @IsString() @MaxLength(3) currencyCode?: string;
  @IsOptional() @IsString() @MaxLength(8) currencySymbol?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(40, { each: true })
  languages?: string[];
  @IsOptional() @IsBoolean() mirrorLanguage?: boolean;
  @IsOptional() @IsString() @MaxLength(8) voiceLanguage?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) paymentMethods?: string[];
  @IsOptional() @IsString() @MaxLength(2000) paymentDetails?: string;
  @IsOptional() @IsObject() skills?: Record<string, unknown>;
  @IsOptional() @IsObject() handoff?: Record<string, unknown>;
  @IsOptional() @IsObject() hours?: Record<string, unknown>;
}

export class UpdateStoreProfileDto {
  @IsOptional() @IsString() @MaxLength(120) brandName?: string;
  @IsOptional() @IsString() @MaxLength(2000) tone?: string;
  @IsOptional() @IsString() @MaxLength(3) currencyCode?: string;
  @IsOptional() @IsString() @MaxLength(8) currencySymbol?: string;
  @IsOptional() @IsString() @MaxLength(2) countryCode?: string;
  @IsOptional() @IsString() @MaxLength(2000) paymentDetails?: string;
}

export class ImportUrlDto {
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(2000)
  url!: string;
}

export class TestQuestionDto {
  @IsString() @MaxLength(500) question!: string;
  @IsOptional() @IsInt() storeId?: number;
}

export class PlaygroundMessageDto {
  @IsIn(['customer', 'ai']) role!: 'customer' | 'ai';
  @IsString() @MaxLength(4000) text!: string;
}

export class PlaygroundDto {
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => PlaygroundMessageDto)
  messages!: PlaygroundMessageDto[];
  @IsOptional() @IsObject() memory?: Record<string, unknown>;
  @IsOptional() @IsInt() storeId?: number;
}

export class FeedbackDto {
  @IsInt() messageId!: number;
  @IsIn([1, -1]) rating!: number;
  @IsOptional() @IsString() @MaxLength(64) reason?: string;
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}

export class NumberStoreDto {
  @IsOptional() @IsInt() @Min(1) storeId?: number | null;
}

export class PerformanceQueryDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(365) days?: number;
}
