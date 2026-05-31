import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
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

  /** Target every active contact in the company. */
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

  /**
   * Placeholder → value map. A value may be a literal string OR a contact
   * token: `{{contact.name}}`, `{{contact.phone}}`, `{{contact.email}}`,
   * `{{contact.custom.<key>}}` — resolved per-recipient at send time.
   */
  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;
}
