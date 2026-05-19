import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OgService } from './og.service';

/**
 * Shell-Polish-C: GET /api/og?url=<encoded-url>
 *
 * JWT-guarded (auth gates SSRF abuse). NOT tenant-scoped — OG data is public
 * page metadata, not tenant state. Always 200 with `{ ok }` on a fetch miss;
 * 400 only for missing/malformed/blocked-scheme-or-host. Never 5xx.
 */
@Controller('og')
@UseGuards(AuthGuard('jwt'))
export class OgController {
  constructor(private readonly og: OgService) {}

  @Get()
  get(@Query('url') url?: string) {
    return this.og.getPreview(url);
  }
}
