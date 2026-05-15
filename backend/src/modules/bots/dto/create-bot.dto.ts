import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export enum BotTriggerType {
  exact = 'exact',
  contains = 'contains',
  regex = 'regex',
}

export enum BotActionType {
  reply_template = 'reply_template',
  send_text = 'send_text',
  assign_agent = 'assign_agent',
  apply_tag = 'apply_tag',
  fire_webhook = 'fire_webhook',
}

export class BotActionDto {
  @IsEnum(BotActionType)
  type!: BotActionType;

  @IsOptional()
  @IsInt()
  templateId?: number;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  message?: string;

  @IsOptional()
  @IsInt()
  userId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  tag?: string;

  @IsOptional()
  @IsInt()
  webhookEndpointId?: number;
}

export class CreateBotDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @IsEnum(BotTriggerType)
  triggerType!: BotTriggerType;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  keyword!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => BotActionDto)
  actions!: BotActionDto[];
}
