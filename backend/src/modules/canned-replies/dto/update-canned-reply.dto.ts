import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateCannedReplyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  body?: string;
}
