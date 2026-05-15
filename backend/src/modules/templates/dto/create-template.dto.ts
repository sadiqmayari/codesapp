import {
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum TemplateCategory {
  marketing = 'marketing',
  utility = 'utility',
  authentication = 'authentication',
}

export class CreateTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  name!: string;

  @IsEnum(TemplateCategory)
  category!: TemplateCategory;

  @IsString()
  @MinLength(2)
  @MaxLength(16)
  language!: string;

  @IsArray()
  @IsObject({ each: true })
  components!: Array<Record<string, unknown>>;
}
