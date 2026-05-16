import {
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  MinLength,
} from 'class-validator';

export class CreateEndpointDto {
  @IsUrl({ require_protocol: true, protocols: ['https'] })
  endpointUrl!: string;

  @IsString()
  @MinLength(16)
  secret!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  events!: string[];

  @IsOptional()
  @IsString()
  status?: 'active' | 'inactive';
}
