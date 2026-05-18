import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class UpdateShopifyEventsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  events!: string[];
}
