import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ShopifyOrderConfigDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsInt()
  templateId?: number | null;

  @IsObject()
  variableMap!: Record<string, string>;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  confirmTag!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  cancelTag!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  shopDomain?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  apiVersion?: string;
}
