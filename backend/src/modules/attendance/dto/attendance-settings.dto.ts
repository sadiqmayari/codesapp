import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

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

  // Comma-separated office IPs/CIDRs (the office network). Empty clears it.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  officeIps?: string;
}
