import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { SegmentFilterDto } from '../../contacts/dto/create-segment.dto';

/**
 * Resolve a prospective audience (without creating a broadcast) so the
 * campaign builder can show a live recipient count + sample before sending.
 */
export class PreviewAudienceDto {
  @IsOptional()
  @IsBoolean()
  all?: boolean;

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
}
