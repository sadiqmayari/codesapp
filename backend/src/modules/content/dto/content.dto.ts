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

  // Brief / shot list / full script / caption — line breaks preserved.
  @IsOptional()
  @IsString()
  @MaxLength(20000)
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

  // Campaign / folder (ContentCollection) to file this under. Omit = standalone.
  @IsOptional()
  @IsInt()
  collectionId?: number;
}

/** One planned content item with NO media yet (status 'planned'). */
export class CreatePlanDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  // Brief / shot list / full script / caption — line breaks preserved.
  @IsOptional()
  @IsString()
  @MaxLength(20000)
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

  // Campaign / folder (ContentCollection) to file this under. Omit = standalone.
  @IsOptional()
  @IsInt()
  collectionId?: number;
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

/** Create a campaign or folder (both = a named Google Drive folder). */
export class CreateCollectionDto {
  @IsIn(['campaign', 'folder'])
  kind!: 'campaign' | 'folder';

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsISO8601()
  launchDate?: string;
}

/** Edit a collection. All fields optional; name change renames the Drive folder. */
export class UpdateCollectionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsISO8601()
  launchDate?: string | null;

  @IsOptional()
  @IsIn(['active', 'archived'])
  status?: 'active' | 'archived';
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
