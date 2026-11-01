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

  // The dialling Asterisk endpoint name ("agent-<companyId>-<userId>"), so an
  // outbound call can be attributed to the agent who placed it.
  @IsOptional()
  @IsString()
  agent?: string;

  // Base64 of the caller's SIP display name (Meta's WhatsApp profile name),
  // base64-encoded by the dialplan to avoid JSON/quote/unicode escaping issues.
  // Used to name a brand-new contact created from an inbound call.
  @IsOptional()
  @IsString()
  callerNameB64?: string;
}
