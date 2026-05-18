import { IsString, MinLength, MaxLength } from 'class-validator';

export class SetShopifyAdminTokenDto {
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  token!: string;
}
