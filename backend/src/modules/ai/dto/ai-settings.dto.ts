import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class UpdateAiSettingsDto {
  @IsOptional()
  @IsBoolean()
  aiEnabled?: boolean;

  // Tenant-selectable autonomous AI quality. 'fast' = Standard, 'smart' =
  // High-accuracy, null = follow the platform default.
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(['fast', 'smart'])
  aiTier?: 'fast' | 'smart' | null;

  // Multimodal AI (tenant-controlled). The super-admin kill-switch overrides.
  @IsOptional()
  @IsBoolean()
  visionEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  voiceEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  autoReplyEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  autoOrderEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  autoOrderAllEnabled?: boolean;

  // null clears the stored tone.
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(2000)
  brandTone?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(32)
  defaultLanguage?: string | null;

  // Self-imposed monthly spend cap in cents (billed amount). null clears it
  // (falls back to the platform default). 0 = unlimited.
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  monthlyCapCents?: number | null;
}
