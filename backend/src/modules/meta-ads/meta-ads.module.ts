import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ShopifyModule } from '../integrations/shopify/shopify.module';
import { MetaMarketingClientService } from './meta-marketing-client.service';
import { MetaAdsSyncService } from './meta-ads-sync.service';
import { MetaAdsService } from './meta-ads.service';
import { MetaAdsController } from './meta-ads.controller';
import { MetaAdsCronController } from './meta-ads-cron.controller';

/**
 * Meta Ads module: daily spend ingestion from the Meta Marketing API (Ads
 * Insights), Settings connect endpoints, and per-product monthly targets. The
 * report itself lives in AnalyticsService (GET /analytics/product-roas).
 * EncryptionService / JobQueueService / PrismaService come from the @Global
 * CommonModule + PrismaModule.
 */
@Module({
  imports: [AuthModule, ShopifyModule],
  controllers: [MetaAdsController, MetaAdsCronController],
  providers: [MetaMarketingClientService, MetaAdsSyncService, MetaAdsService],
  exports: [MetaAdsSyncService],
})
export class MetaAdsModule {}
