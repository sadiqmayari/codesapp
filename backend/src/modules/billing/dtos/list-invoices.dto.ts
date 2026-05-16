import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListInvoicesDto {
  @IsOptional()
  @IsIn(['pending', 'paid', 'overdue', 'cancelled'])
  status?: 'pending' | 'paid' | 'overdue' | 'cancelled';

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
