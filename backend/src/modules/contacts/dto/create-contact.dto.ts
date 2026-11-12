import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Loose input check only — the real rule is `canonContactPhone` +
 * `isValidContactPhone` (common/utils/contact-phone.ts), applied in the
 * service, so local formats like `0300-1234567` are accepted and canonicalized.
 */
export const PHONE_REGEX = /^\+?[1-9]\d{6,14}$/;

/** '' → null so a cleared field actually clears instead of failing @IsEmail. */
export const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

export class CreateContactDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsString()
  @MinLength(7)
  @MaxLength(32)
  phone!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsEmail()
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  city?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}
