import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PayrollPolicyDto } from './payroll.dto';

// Declared BEFORE AttendanceSettingsDto: decorator metadata references it at
// class-definition time (a later class = TDZ ReferenceError at boot).
export class AutoCheckoutDto {
  @IsOptional()
  @IsIn(['off', 'shift_end', 'max_hours'])
  mode?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(600)
  afterEndMin?: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(20)
  maxHours?: number;
}

export class AttendanceSettingsDto {
  // "HH:MM" 24h, tenant-local. Omit/empty keeps the default (09:30).
  @IsOptional()
  @IsString()
  @Matches(/^(([01]\d|2[0-3]):[0-5]\d)?$/, { message: 'workStartTime must be HH:MM or empty' })
  workStartTime?: string;

  // General shift end "HH:MM" (drives early-leave + overtime). Empty clears it.
  @IsOptional()
  @IsString()
  @Matches(/^(([01]\d|2[0-3]):[0-5]\d)?$/, { message: 'workEndTime must be HH:MM or empty' })
  workEndTime?: string;

  // Grace minutes after shift start before a check-in is Late (0–240).
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  graceMinutes?: number;

  // Comma-separated office IPs/CIDRs (the office network). Empty clears it.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  officeIps?: string;

  // Check-in window: minutes after each user's shift start that the check-in CTA
  // stays available (0–1440). null/omit → default 150 (2.5h).
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(1440)
  checkinWindowMinutes?: number;

  // Tenant payroll policy (late/absence + overtime methods). Merged over defaults.
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PayrollPolicyDto)
  payrollPolicy?: PayrollPolicyDto;

  // Auto-checkout policy (merged over current, clamped by resolveAutoCheckout).
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AutoCheckoutDto)
  autoCheckout?: AutoCheckoutDto;

  // Company weekly off days, 0 = Sunday … 6 = Saturday.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weeklyOff?: number[];

  // Default annual paid-leave days (0 = not tracked).
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  annualPaidLeave?: number | null;
}
