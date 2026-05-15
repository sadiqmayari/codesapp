import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SegmentFilterDto } from '../../contacts/dto/create-segment.dto';

export class CreateBroadcastDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsInt()
  templateId!: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  contactIds?: number[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SegmentFilterDto)
  filter?: SegmentFilterDto;

  @IsOptional()
  @IsInt()
  segmentId?: number;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;
}
