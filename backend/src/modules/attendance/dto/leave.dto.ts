import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

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

  @IsOptional()
  @IsIn(['casual', 'sick', 'annual', 'unpaid', 'other'])
  leaveType?: 'casual' | 'sick' | 'annual' | 'unpaid' | 'other';

  @IsOptional()
  @IsBoolean()
  paid?: boolean;
}

/** "Fix my day": ask the admin to set a past day's punch times. */
export class CorrectionRequestDto {
  @IsString()
  date!: string;

  @IsOptional()
  @IsString()
  @Matches(/^(([01]\d|2[0-3]):[0-5]\d)?$/)
  checkIn?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(([01]\d|2[0-3]):[0-5]\d)?$/)
  checkOut?: string;

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
