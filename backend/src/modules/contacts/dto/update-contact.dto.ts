import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { emptyToNull } from './create-contact.dto';

export enum ContactStatus {
  active = 'active',
  blocked = 'blocked',
  archived = 'archived',
}

export class UpdateContactDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  /** Owner/admin only (enforced in the service) — corrects a mistyped number. */
  @IsOptional()
  @IsString()
  @MinLength(7)
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsEmail()
  email?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(128)
  city?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;

  @IsOptional()
  @IsEnum(ContactStatus)
  status?: ContactStatus;

  /** true = opted out of marketing (broadcasts), false = re-subscribed. */
  @IsOptional()
  @IsBoolean()
  optedOut?: boolean;
}
