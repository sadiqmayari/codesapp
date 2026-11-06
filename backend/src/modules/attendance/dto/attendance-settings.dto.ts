import { IsOptional, IsString, Matches } from 'class-validator';

export class AttendanceSettingsDto {
  // "HH:MM" 24h, tenant-local. Omit/empty keeps the default (09:30).
  @IsOptional()
  @IsString()
  @Matches(/^(\d{2}:\d{2})?$/, { message: 'workStartTime must be HH:MM or empty' })
  workStartTime?: string;
}
