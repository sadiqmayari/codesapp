import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCannedReplyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  body!: string;
}
