import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AllowanceDto } from './payroll.dto';

export class UpdateMemberDto {
  // "HH:MM" per-user shift override, or empty string to clear (→ company default).
  @IsOptional()
  @IsString()
  @Matches(/^(([01]\d|2[0-3]):[0-5]\d)?$/, { message: 'workStartTime must be HH:MM or empty' })
  workStartTime?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(([01]\d|2[0-3]):[0-5]\d)?$/, { message: 'workEndTime must be HH:MM or empty' })
  workEndTime?: string;

  // Per-user grace minutes override (null clears → company default).
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  graceMinutes?: number | null;

  @IsOptional()
  @IsBoolean()
  requireOfficeIp?: boolean;

  // Payroll v3 ─────────────────────────────────────────────────────────────
  // "Flexible timing" — never mark this member late / early-leave.
  @IsOptional()
  @IsBoolean()
  exemptLate?: boolean;

  // Monthly gross base salary. null clears it.
  @IsOptional()
  @IsNumber()
  @Min(0)
  salaryAmount?: number | null;

  // Optional per-user flat Rs/hour overtime rate override. null clears it.
  @IsOptional()
  @IsNumber()
  @Min(0)
  overtimeRate?: number | null;

  // Allowance lines {label, amount}. Replaces the whole set when provided.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllowanceDto)
  allowances?: AllowanceDto[];

  // ── Team v4 ──
  // Flexible staff daily target minutes (null clears → 480).
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(1440)
  requiredMinutes?: number | null;

  // Per-user weekly off days (null clears → company default).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weeklyOff?: number[] | null;

  // YYYY-MM-DD or "" to clear.
  @IsOptional()
  @IsString()
  joinedOn?: string;

  @IsOptional()
  @IsString()
  leftOn?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  annualPaidLeave?: number | null;
}
