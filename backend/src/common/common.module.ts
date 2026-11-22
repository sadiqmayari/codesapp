import { Module, Global } from '@nestjs/common';
import { EncryptionService } from './services/encryption.service';
import { CacheService } from './services/cache.service';
import { MediaService } from './services/media.service';
import { JobQueueService } from './services/job-queue.service';
import { PlatformSettingService } from './services/platform-setting.service';
import { MailService } from './services/mail.service';
import { CompanyStatusService } from './services/company-status.service';
import { EventStoreService } from './services/event-store.service';
import { FeatureService } from './services/feature.service';
import { OrderIdempotencyService } from './services/order-idempotency.service';
import { ObservabilityService } from './services/observability.service';
import { CustomerRegistryService } from './services/customer-registry.service';
import { AgentActivityService } from './services/agent-activity.service';
import { SipTrunkAuthService } from './services/sip-trunk-auth.service';
import { SharedStateService } from './services/shared-state.service';
import { OrderAttributionService } from './services/order-attribution.service';
import { InventoryLedgerService } from '../modules/inventory/core/inventory-ledger.service';

@Global()
@Module({
  providers: [
    EncryptionService,
    CacheService,
    MediaService,
    JobQueueService,
    PlatformSettingService,
    MailService,
    CompanyStatusService,
    EventStoreService,
    FeatureService,
    OrderIdempotencyService,
    ObservabilityService,
    CustomerRegistryService,
    AgentActivityService,
    SipTrunkAuthService,
    SharedStateService,
    OrderAttributionService,
    InventoryLedgerService,
  ],
  exports: [
    EncryptionService,
    CacheService,
    MediaService,
    JobQueueService,
    PlatformSettingService,
    MailService,
    CompanyStatusService,
    EventStoreService,
    FeatureService,
    OrderIdempotencyService,
    ObservabilityService,
    CustomerRegistryService,
    AgentActivityService,
    SipTrunkAuthService,
    SharedStateService,
    OrderAttributionService,
    InventoryLedgerService,
  ],
})
export class CommonModule {}
