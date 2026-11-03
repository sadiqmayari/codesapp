import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ConnectMetaAdsDto {
  // Numeric ad account id (we also accept an "act_" prefix and strip it).
  @IsString()
  @Matches(/^(act_)?\d{3,}$/, {
    message: 'adAccountId must be the numeric Meta ad account id (e.g. 1234567890)',
  })
  adAccountId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  // Optional OVERRIDE token. Blank = reuse the WhatsApp/onboarding token.
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(1000)
  token?: string;
}
