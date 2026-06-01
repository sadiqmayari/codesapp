import { Controller, Get } from '@nestjs/common';
import { PublicService } from './public.service';

/**
 * UNAUTHENTICATED public catalog. No guards by design — these endpoints serve
 * the marketing landing page to logged-out visitors. Lives under the `/api`
 * global prefix (→ `/api/public/*`); never add tenant/JWT data here.
 */
@Controller('public')
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  @Get('pricing')
  pricing() {
    return this.publicService.getPricing();
  }
}
