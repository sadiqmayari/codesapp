import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Send a single real template message to one phone number to preview a
 * campaign before the full blast. Does NOT touch broadcast counters.
 */
export class TestSendDto {
  @IsInt()
  templateId!: number;

  @IsString()
  @MinLength(5)
  @MaxLength(20)
  phone!: string;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;
}
