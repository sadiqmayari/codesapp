import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
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

  @IsOptional()
  @IsISO8601()
  deadline?: string;

  @IsOptional()
  @IsInt()
  assigneeUserId?: number;
}

/** One planned content item with NO media yet (status 'planned'). */
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

  @IsOptional()
  @IsISO8601()
  deadline?: string;

  @IsOptional()
  @IsInt()
  assigneeUserId?: number;
}

/** Assign (or reassign) a content task to an uploader. null = unassign. */
export class AssignContentDto {
  @IsOptional()
  @IsInt()
  assigneeUserId?: number | null;
}

/** Plan several items at once (the planning list). */
export class CreatePlanBulkDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreatePlanDto)
  items!: CreatePlanDto[];
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
  // null clears the field; undefined leaves it unchanged.
  @IsOptional()
  @IsISO8601()
  scheduledPublishAt?: string | null;

  @IsOptional()
  @IsISO8601()
  deadline?: string | null;
}
