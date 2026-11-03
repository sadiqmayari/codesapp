import { IsInt, IsOptional, Min } from 'class-validator';

export class SetMetaAdsSyncScheduleDto {
  // null = platform default; clamped server-side to [30, 1440].
  @IsOptional()
  @IsInt()
  @Min(1)
  intervalMinutes?: number | null;
}
