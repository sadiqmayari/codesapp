import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export const TICKET_STATUSES = [
  'open',
  'in_progress',
  'awaiting_customer',
  'resolved',
  'rejected',
] as const;

export class UpdateTicketDto {
  @IsOptional()
  @IsIn(TICKET_STATUSES as unknown as string[])
  status?: string;

  @IsOptional()
  @IsInt()
  assignedUserId?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  resolutionNote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(48)
  resolutionCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(48)
  reasonCode?: string;
}
