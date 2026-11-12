import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  Max,
  Min,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ContactStatus } from './update-contact.dto';

export class SegmentFilterDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsEnum(ContactStatus)
  status?: ContactStatus;

  @IsOptional()
  @IsDateString()
  lastMessageAfter?: string;

  @IsOptional()
  @IsDateString()
  lastMessageBefore?: string;

  @IsOptional()
  @IsBoolean()
  hasEmail?: boolean;

  /** 'all' (default) = contact has every tag; 'any' = at least one. */
  @IsOptional()
  @IsIn(['all', 'any'])
  tagMode?: 'all' | 'any';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  excludeTags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(128)
  city?: string;

  @IsOptional()
  @IsBoolean()
  optedOut?: boolean;

  @IsOptional()
  @IsDateString()
  createdAfter?: string;

  @IsOptional()
  @IsDateString()
  createdBefore?: string;
}

export class SegmentPreviewQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class CreateSegmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => SegmentFilterDto)
  filter!: SegmentFilterDto;
}

export class UpdateSegmentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SegmentFilterDto)
  filter?: SegmentFilterDto;
}
