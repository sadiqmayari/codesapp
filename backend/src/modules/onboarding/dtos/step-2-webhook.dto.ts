import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class Step2WebhookDto {
  /** The verify token the client typed into THEIR Meta app webhook config. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  verifyToken!: string;

  /**
   * The client's Meta app secret — used to HMAC-validate inbound POSTs.
   * Optional on re-submit: omit/blank to keep the previously stored value.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  appSecret?: string;
}
