import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/** The config/appliesTo blobs are validated + clamped by resolvePlanConfig / resolveAppliesTo. */
export class CommissionPlanDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsString()
  metric!: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsObject()
  config!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  appliesTo?: Record<string, unknown>;
}

export class PreviewPlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsString()
  metric!: string;

  @IsObject()
  config!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  appliesTo?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  month?: string;
}
