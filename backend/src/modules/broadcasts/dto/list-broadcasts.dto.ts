import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export enum BroadcastStatusFilter {
  draft = 'draft',
  scheduled = 'scheduled',
  sending = 'sending',
  completed = 'completed',
  failed = 'failed',
  cancelled = 'cancelled',
}

export class ListBroadcastsDto {
  @IsOptional()
  @IsEnum(BroadcastStatusFilter)
  status?: BroadcastStatusFilter;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;
}
