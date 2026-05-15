import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BotActionDto, BotTriggerType } from './create-bot.dto';

export class UpdateBotDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsEnum(BotTriggerType)
  triggerType?: BotTriggerType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  keyword?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BotActionDto)
  actions?: BotActionDto[];
}
