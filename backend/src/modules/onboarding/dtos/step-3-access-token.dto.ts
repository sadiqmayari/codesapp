import { IsOptional, IsString, MinLength } from 'class-validator';

export class Step3AccessTokenDto {
  /**
   * Optional on re-submit: omit/blank to keep the previously stored token
   * (it is encrypted and never returned, so re-editing earlier steps must
   * not force re-pasting it).
   */
  @IsOptional()
  @IsString()
  @MinLength(10)
  accessToken?: string;
}
