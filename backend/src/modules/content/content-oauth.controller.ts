import { Controller, Get, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { GDriveService } from './gdrive.service';

/**
 * PUBLIC (no guards) — Google's OAuth redirect lands here. The tenant is
 * resolved from the HMAC-signed `state` (not from a session), so no auth
 * guard is needed/possible. Lives under the global /api prefix:
 *   GET /api/content/oauth/callback?code=...&state=...
 * Always finishes by redirecting the human back into the app.
 */
@Controller('content/oauth')
export class ContentOAuthController {
  constructor(
    private readonly gdrive: GDriveService,
    private readonly config: ConfigService,
  ) {}

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    const base = (this.config.get<string>('APP_URL') || '').replace(/\/$/, '');
    const back = (status: string) => `${base}/content?drive=${status}`;

    if (error) return res.redirect(back('denied'));
    const companyId = state ? this.gdrive.verifyState(state) : null;
    if (!companyId || !code) return res.redirect(back('error'));

    try {
      await this.gdrive.handleCallback(companyId, code);
      return res.redirect(back('connected'));
    } catch {
      return res.redirect(back('error'));
    }
  }
}
