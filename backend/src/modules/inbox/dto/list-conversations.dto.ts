import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
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

  // Owner/admin assignee filter: show ONLY unassigned chats. Ignored for agents
  // (their view is always scoped to unassigned + their own).
  // NOT @Type(() => Boolean): that turns the string "false" into true.
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  unassigned?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
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
