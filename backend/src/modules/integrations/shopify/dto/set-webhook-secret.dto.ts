import { IsString, MinLength, MaxLength } from 'class-validator';

export class SetShopifyWebhookSecretDto {
  @IsString()
  @MinLength(8)
  @MaxLength(255)
  secret!: string;
}
