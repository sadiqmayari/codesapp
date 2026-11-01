import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CallsSecretGuard } from '../../common/guards/calls-secret.guard';
import { CallsService } from './calls.service';
import { CallEventDto } from './dto/call-event.dto';

/**
 * Asterisk -> app call-event webhook. Shared-secret (X-Calls-Secret), no JWT.
 * Under /api (global prefix); the Asterisk dialplan posts here per call event.
 */
@Controller('calls')
export class CallsWebhookController {
  constructor(private readonly calls: CallsService) {}

  @Post('events')
  @UseGuards(CallsSecretGuard)
  event(@Body() dto: CallEventDto) {
    return this.calls.handleEvent(dto);
  }
}
