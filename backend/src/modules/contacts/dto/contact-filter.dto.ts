import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ContactStatus } from './update-contact.dto';

/** `?tags=a,b` or `?tags=a&tags=b` (or a JSON body array) → string[]. */
const toList = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const arr = Array.isArray(value) ? value : String(value).split(',');
  return arr.map((v) => String(v).trim()).filter(Boolean);
};
const toBool = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
};

/**
 * Contacts 360 shared filter — mirrors `ContactFilter` (contact-query.ts).
 * Used by list, export and bulk-by-filter so all three select the same rows.
 */
export class ContactFilterDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /** Legacy single-tag param (kept for existing callers). */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  tag?: string;

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(['all', 'any'])
  tagMode?: 'all' | 'any';

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  excludeTags?: string[];

  @IsOptional()
  @IsEnum(ContactStatus)
  status?: ContactStatus;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  city?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  hasEmail?: boolean;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  optedOut?: boolean;

  @IsOptional()
  @IsDateString()
  lastMessageAfter?: string;

  @IsOptional()
  @IsDateString()
  lastMessageBefore?: string;

  @IsOptional()
  @IsDateString()
  createdAfter?: string;

  @IsOptional()
  @IsDateString()
  createdBefore?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  segmentId?: number;

  /** Restore view: list soft-deleted contacts (owner/admin only, enforced in service). */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  deleted?: boolean;
}
