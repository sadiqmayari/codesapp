import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ContactFilterDto } from './contact-filter.dto';
import { ContactStatus } from './update-contact.dto';

export const BULK_ACTIONS = [
  'tag_add',
  'tag_remove',
  'status',
  'opt_out',
  'opt_in',
  'delete',
  'restore',
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

export class BulkContactsDto {
  @IsIn(BULK_ACTIONS as unknown as string[])
  action!: BulkAction;

  /** Explicit selection. Either `ids` or `filter` (select-all-matching). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @IsInt({ each: true })
  ids?: number[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ContactFilterDto)
  filter?: ContactFilterDto;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  @IsOptional()
  @IsEnum(ContactStatus)
  status?: ContactStatus;
}

export class MergeContactsDto {
  @IsInt()
  primaryId!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  mergeIds!: number[];
}

