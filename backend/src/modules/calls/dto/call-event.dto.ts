import { IsIn, IsOptional, IsString, IsInt, Min } from 'class-validator';

/**
 * Payload the Asterisk dialplan POSTs to /api/calls/events for each call
 * lifecycle transition. `callId` = Asterisk UNIQUEID (stable per call).
 */
export class CallEventDto {
  @IsIn(['call_started', 'call_answered', 'call_ended'])
  event!: 'call_started' | 'call_answered' | 'call_ended';

  @IsIn(['inbound', 'outbound'])
  direction!: 'inbound' | 'outbound';

  @IsString()
  callId!: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  // For call_ended: whether the call was ever answered (else it's a missed call).
  @IsOptional()
  answered?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  durationSec?: number;
}
