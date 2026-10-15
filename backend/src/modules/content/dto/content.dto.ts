import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Metadata that accompanies a multipart upload (file is handled separately). */
export class CreateContentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  caption?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  platform?: string;

  @IsOptional()
  @IsISO8601()
  scheduledPublishAt?: string;
}

/** Plan a content item with NO media yet (status 'planned'). */
export class CreatePlanDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  caption?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  platform?: string;

  @IsOptional()
  @IsISO8601()
  scheduledPublishAt?: string;
}

/** Owner/admin review decision. `needs_changes` should carry feedback. */
export class ReviewContentDto {
  @IsIn(['approved', 'needs_changes', 'rejected'])
  decision!: 'approved' | 'needs_changes' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  feedback?: string;
}

export class ScheduleContentDto {
  // null clears the scheduled date.
  @IsOptional()
  @IsISO8601()
  scheduledPublishAt?: string | null;
}
