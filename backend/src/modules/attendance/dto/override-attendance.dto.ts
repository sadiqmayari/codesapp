import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export type AttendanceStatusValue =
  | 'present'
  | 'absent'
  | 'leave'
  | 'half_day'
  | 'holiday';

/**
 * Admin override of a single member's day. All fields optional — only the
 * provided ones are written. A time is "HH:MM" (24h, tenant-local) or an empty
 * string to CLEAR that timestamp.
 */
export class OverrideAttendanceDto {
  @IsOptional()
  @IsIn(['present', 'absent', 'leave', 'half_day', 'holiday'])
  status?: AttendanceStatusValue;

  @IsOptional()
  @IsString()
  @Matches(/^(\d{2}:\d{2})?$/, { message: 'checkIn must be HH:MM or empty' })
  checkIn?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(\d{2}:\d{2})?$/, { message: 'checkOut must be HH:MM or empty' })
  checkOut?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}
