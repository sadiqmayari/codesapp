import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class RequestPlanChangeDto {
  /** The plan the tenant wants. Omit for a generic "let's discuss" request. */
  @IsOptional()
  @IsInt()
  requestedSubscriptionId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
