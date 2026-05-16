import { IsString, MinLength } from 'class-validator';

export class Step5TestMessageDto {
  @IsString()
  @MinLength(5)
  toPhone!: string;

  @IsString()
  @MinLength(1)
  templateName!: string;

  @IsString()
  @MinLength(2)
  languageCode!: string;
}
