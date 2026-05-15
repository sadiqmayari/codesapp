import { IsEnum, IsOptional } from 'class-validator';
import { TemplateCategory } from './create-template.dto';

export enum TemplateStatus {
  pending = 'pending',
  approved = 'approved',
  rejected = 'rejected',
  paused = 'paused',
}

export class ListTemplatesDto {
  @IsOptional()
  @IsEnum(TemplateStatus)
  status?: TemplateStatus;

  @IsOptional()
  @IsEnum(TemplateCategory)
  category?: TemplateCategory;
}
