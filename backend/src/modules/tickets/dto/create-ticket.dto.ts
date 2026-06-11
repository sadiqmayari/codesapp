import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const TICKET_TYPES = [
  'refund',
  'return',
  'exchange',
  'damaged',
  'wrong_item',
  'missing',
  'complaint',
  'other',
] as const;

/** Agent-created (manual) ticket — always tied to a conversation. */
export class CreateTicketDto {
  @IsInt()
  conversationId!: number;

  @IsIn(TICKET_TYPES as unknown as string[])
  type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  linkedOrderName?: string;

  @IsOptional()
  @IsInt()
  assignedUserId?: number;
}
