import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SuggestReplyDto {
  @IsInt()
  conversationId!: number;

  /** Optional steer, e.g. "offer a 10% discount" or "ask for their order #". */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instruction?: string;
}

export class SummarizeDto {
  @IsInt()
  conversationId!: number;
}

export type RewriteMode = 'polite' | 'shorten' | 'expand' | 'fix';

export class RewriteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;

  @IsIn(['polite', 'shorten', 'expand', 'fix'])
  mode!: RewriteMode;
}

export class TranslateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;

  /** Target language label, e.g. "English", "Urdu", "Roman Urdu". */
  @IsString()
  @MinLength(2)
  @MaxLength(32)
  targetLang!: string;
}
