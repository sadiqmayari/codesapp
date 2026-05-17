import { IsOptional, IsString, MaxLength } from 'class-validator';

export class Step2WebhookDto {
  /**
   * The client's Meta app secret — used to HMAC-validate inbound POSTs.
   * Optional on re-submit: omit/blank to keep the previously stored value.
   * (The verify token is auto-generated server-side, not supplied here.)
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  appSecret?: string;
}
