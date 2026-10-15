import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ShopifyModule } from '../integrations/shopify/shopify.module';
import { PrController } from './pr.controller';
import { PublicPrController } from './public-pr.controller';
import { PrService } from './pr.service';
import { PublicPrService } from './public-pr.service';

/**
 * PR module — influencer outreach. AuthModule provides the JWT guard;
 * ShopifyModule exports CommerceResolverService for the 0-amount "PR" order.
 * Prisma / FeatureService come from the @Global CommonModule. The public
 * submission controller is guard-less (token-gated). Leaf module → no cycle.
 */
@Module({
  imports: [AuthModule, ShopifyModule],
  controllers: [PrController, PublicPrController],
  providers: [PrService, PublicPrService],
})
export class PrModule {}
