import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ShopifyModule } from '../integrations/shopify/shopify.module';
import { AiModule } from '../ai/ai.module';
import { GrowthController } from './growth.controller';
import { GrowthCronController } from './growth-cron.controller';
import { GrowthService } from './growth.service';
import { MetaAdapter } from './platforms/meta/meta.adapter';
import { GoogleAdsAdapter } from './platforms/google/google.adapter';
import { TikTokAdsAdapter } from './platforms/tiktok/tiktok.adapter';
import { SnapAdsAdapter } from './platforms/snap/snap.adapter';
import { PlatformRegistry } from './platforms/platform-registry';
import { AdAccountsService } from './services/ad-accounts.service';
import { AdSyncService } from './services/ad-sync.service';
import { FxService } from './services/fx.service';
import { GrowthVersionService } from './services/growth-version.service';
import { GrowthFactsService } from './services/growth-facts.service';
import { GrowthQueryService } from './services/growth-query.service';
import { GrowthForecastService } from './services/growth-forecast.service';
import { GrowthOpportunityService } from './services/growth-opportunity.service';
import { GrowthAiService } from './services/growth-ai.service';
import { CapiService } from './services/capi.service';
import { MariaDbStore } from './store/mariadb.store';
import { ClickHouseStore } from './store/clickhouse.store';
import { GrowthMirrorService } from './store/growth-mirror.service';
import { MetaWriter } from './platforms/meta/meta.writer';
import { AdManageService } from './services/ad-manage.service';
import { AdCreateService } from './services/ad-create.service';
import { GrowthTargetService } from './services/growth-target.service';

/**
 * Growth (formerly "Ad Report"): the parent module for multi-platform ads,
 * attribution, profit, forecasting and AI. Sub-areas live under
 * modules/growth/{platforms,attribution,store,metrics,services}.
 */
@Module({
  imports: [AuthModule, ShopifyModule, AiModule],
  controllers: [GrowthController, GrowthCronController],
  providers: [
    GrowthService,
    MetaAdapter,
    GoogleAdsAdapter,
    TikTokAdsAdapter,
    SnapAdsAdapter,
    PlatformRegistry,
    AdAccountsService,
    AdSyncService,
    FxService,
    GrowthVersionService,
    GrowthFactsService,
    GrowthQueryService,
    GrowthForecastService,
    GrowthOpportunityService,
    GrowthAiService,
    CapiService,
    MariaDbStore,
    ClickHouseStore,
    GrowthMirrorService,
    MetaWriter,
    AdManageService,
    AdCreateService,
    GrowthTargetService,
  ],
})
export class GrowthModule {}
