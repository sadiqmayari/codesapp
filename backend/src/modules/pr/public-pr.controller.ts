import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { PublicPrService } from './public-pr.service';
import { PublicPrSubmitDto } from './dto/public-pr.dto';

/**
 * PUBLIC — no guards. Token-gated influencer submission form. Under the global
 * /api prefix:
 *   GET  /api/public/pr/:token        → sanitized campaign/brand for the form
 *   POST /api/public/pr/:token        → accept an influencer submission
 * Any unknown/inactive token → 404 (no existence leak).
 */
@Controller('public/pr')
export class PublicPrController {
  constructor(private readonly service: PublicPrService) {}

  @Get(':token')
  getForm(@Param('token') token: string) {
    return this.service.getForm(token);
  }

  @Post(':token')
  submit(@Param('token') token: string, @Body() dto: PublicPrSubmitDto) {
    return this.service.submit(token, dto);
  }
}
