import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum SendMessageType {
  text = 'text',
  image = 'image',
  audio = 'audio',
  video = 'video',
  document = 'document',
  template = 'template',
}

export class SendMessageDto {
  @IsEnum(SendMessageType)
  type!: SendMessageType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  content?: string;

  @IsOptional()
  @IsInt()
  templateId?: number;

  @IsOptional()
  @IsObject()
  variables?: Record<string, string>;

  @IsOptional()
  @IsString()
  mediaPath?: string;

  @IsOptional()
  @IsInt()
  contextMessageId?: number;

  // Client-generated optimistic id. Echoed back on the created message + socket
  // so the inbox reconciles the optimistic bubble by client_id (not the weak
  // type+content match). Must be whitelisted here or the global ValidationPipe
  // (forbidNonWhitelisted) rejects the send.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientId?: string;
}
