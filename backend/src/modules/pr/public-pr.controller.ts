import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { PublicPrService } from './public-pr.service';
import { PublicPrSubmitDto } from './dto/public-pr.dto';

/**
 * PUBLIC — no guards. Influencer submission form. Under the global /api prefix:
 *   slug (pr.codentra.pk subdomain):
 *     GET  /api/public/pr/s/:tenant/:campaign
 *     POST /api/public/pr/s/:tenant/:campaign
 *   token (legacy /pr-apply/<token> fallback):
 *     GET  /api/public/pr/:token
 *     POST /api/public/pr/:token
 * Any unknown/inactive campaign → 404 (no existence leak).
 */
@Controller('public/pr')
export class PublicPrController {
  constructor(private readonly service: PublicPrService) {}

  // Slug routes first so they're never shadowed by the :token param.
  @Get('s/:tenant/:campaign')
  getFormBySlugs(
    @Param('tenant') tenant: string,
    @Param('campaign') campaign: string,
  ) {
    return this.service.getFormBySlugs(tenant, campaign);
  }

  @Post('s/:tenant/:campaign')
  submitBySlugs(
    @Param('tenant') tenant: string,
    @Param('campaign') campaign: string,
    @Body() dto: PublicPrSubmitDto,
  ) {
    return this.service.submitBySlugs(tenant, campaign, dto);
  }

  @Get(':token')
  getForm(@Param('token') token: string) {
    return this.service.getForm(token);
  }

  @Post(':token')
  submit(@Param('token') token: string, @Body() dto: PublicPrSubmitDto) {
    return this.service.submit(token, dto);
  }
}
