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

  // Internal-only: full destination URL for a template's dynamic URL button
  // (a URL button whose approved url contains a {{n}} placeholder). The sender
  // derives the required Meta button parameter (the suffix after the button's
  // static prefix) from this. Set by the Shopify confirmation flow with the
  // per-order tracking-page link; ignored when the template has no such button.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  urlButtonUrl?: string;

  // Client-generated optimistic id. Echoed back on the created message + socket
  // so the inbox reconciles the optimistic bubble by client_id (not the weak
  // type+content match). Must be whitelisted here or the global ValidationPipe
  // (forbidNonWhitelisted) rejects the send.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientId?: string;
}
