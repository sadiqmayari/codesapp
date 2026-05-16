import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsInt,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ListLogsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  endpointId?: number;

  @IsOptional()
  @IsString()
  event?: string;

  @IsOptional()
  @IsIn(['pending', 'success', 'failed'])
  status?: 'pending' | 'success' | 'failed';

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
