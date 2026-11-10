import {
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

export class AttendanceSettingsDto {
  // "HH:MM" 24h, tenant-local. Omit/empty keeps the default (09:30).
  @IsOptional()
  @IsString()
  @Matches(/^(\d{2}:\d{2})?$/, { message: 'workStartTime must be HH:MM or empty' })
  workStartTime?: string;

  // General shift end "HH:MM" (drives early-leave + overtime). Empty clears it.
  @IsOptional()
  @IsString()
  @Matches(/^(\d{2}:\d{2})?$/, { message: 'workEndTime must be HH:MM or empty' })
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
  @Min(0)
  @Max(1440)
  checkinWindowMinutes?: number;

  // Tenant payroll policy (late/absence + overtime methods). Merged over defaults.
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PayrollPolicyDto)
  payrollPolicy?: PayrollPolicyDto;
}
