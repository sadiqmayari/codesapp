import {
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
  @Matches(/^(\d{2}:\d{2})?$/, { message: 'workStartTime must be HH:MM or empty' })
  workStartTime?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(\d{2}:\d{2})?$/, { message: 'workEndTime must be HH:MM or empty' })
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
}
