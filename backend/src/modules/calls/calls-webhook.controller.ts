import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CallsSecretGuard } from '../../common/guards/calls-secret.guard';
import { CallsService } from './calls.service';
import { CallEventDto } from './dto/call-event.dto';

/**
 * Asterisk -> app call endpoints. Shared-secret (X-Calls-Secret / ?secret=),
 * no JWT. Under /api (global prefix); the Asterisk dialplan calls these.
 */
@Controller('calls')
export class CallsWebhookController {
  constructor(private readonly calls: CallsService) {}

  @Post('events')
  @UseGuards(CallsSecretGuard)
  event(@Body() dto: CallEventDto) {
    return this.calls.handleEvent(dto);
  }

  /**
   * Dialplan routing lookup. Returns a RAW PJSIP dial string (text/plain) so
   * the Asterisk CURL() dialplan function can Dial() it directly — bypasses the
   * global response envelope via @Res. Secret in the query (CURL can't set
   * headers easily). Always 200 with a (possibly empty) body — never 4xx/5xx,
   * so a lookup failure degrades to "nobody to ring" rather than a dialplan error.
   */
  @Get('route')
  async route(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('secret') secret: string,
    @Res() res: Response,
  ) {
    let body = '';
    if (this.calls.verifyRouteSecret(secret)) {
      body = await this.calls.route(from ?? '', to ?? '');
    }
    res.type('text/plain').send(body);
  }
}
