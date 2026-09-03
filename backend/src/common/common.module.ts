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
  ],
})
export class CommonModule {}
