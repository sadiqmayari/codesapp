import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export enum ConversationListStatus {
  open = 'open',
  resolved = 'resolved',
  pending = 'pending',
  unread = 'unread',
  all = 'all',
}

export class ListConversationsDto {
  @IsOptional()
  @IsEnum(ConversationListStatus)
  status?: ConversationListStatus;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  assignedUserId?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;
}
