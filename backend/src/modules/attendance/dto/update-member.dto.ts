import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

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
}
