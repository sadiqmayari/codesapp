import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
} from 'class-validator';

export class UpdateEndpointDto {
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  endpointUrl?: string;

  @IsOptional()
  @IsString()
  @MinLength(16)
  secret?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  events?: string[];

  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';
}
