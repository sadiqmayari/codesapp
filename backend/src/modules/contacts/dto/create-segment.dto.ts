import {
  IsArray,
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
