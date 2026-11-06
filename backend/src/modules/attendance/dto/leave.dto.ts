import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class LeaveRequestDto {
  // YYYY-MM-DD (or a full ISO string — the service slices to 10 chars).
  @IsString()
  fromDate!: string;

  @IsString()
  toDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReviewLeaveDto {
  @IsIn(['approved', 'rejected'])
  status!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reviewNote?: string;
}
