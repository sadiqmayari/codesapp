import {
  IsArray,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

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

  /**
   * Optional positional BODY parameters for templates that use {{1}}, {{2}}…
   * Maps to WhatsApp `components: [{ type:'body', parameters:[{type:'text'}] }]`.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  bodyParams?: string[];
}
