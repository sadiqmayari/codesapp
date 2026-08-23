import { Module, Global } from '@nestjs/common';
import { EncryptionService } from './services/encryption.service';
import { CacheService } from './services/cache.service';
import { MediaService } from './services/media.service';
import { JobQueueService } from './services/job-queue.service';
import { PlatformSettingService } from './services/platform-setting.service';
import { MailService } from './services/mail.service';
import { CompanyStatusService } from './services/company-status.service';
import { EventStoreService } from './services/event-store.service';
import { OutboxService } from './services/outbox.service';
import { FeatureService } from './services/feature.service';
import { OrderIdempotencyService } from './services/order-idempotency.service';
import { ComplianceGuardService } from './services/compliance-guard.service';
import { KillSwitchService } from './services/kill-switch.service';
import { FrustrationDetectorService } from './services/frustration-detector.service';
import { FraudDetectorService } from './services/fraud-detector.service';
import { ToolValidatorService } from './services/tool-validator.service';
import { ObservabilityService } from './services/observability.service';
import { ImageRouterService } from './services/image-router.service';
import { HandoffSlaService } from './services/handoff-sla.service';
import { ConversationStateMachine } from './services/conversation-state-machine';
import { ConversationStateService } from './services/conversation-state.service';
import { ResponseConfidenceService } from './services/response-confidence.service';
import { FraudSignalCollectorService } from './services/fraud-signal-collector.service';
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
    OutboxService,
    FeatureService,
    OrderIdempotencyService,
    ComplianceGuardService,
    KillSwitchService,
    FrustrationDetectorService,
    FraudDetectorService,
    ToolValidatorService,
    ObservabilityService,
    ImageRouterService,
    HandoffSlaService,
    ConversationStateMachine,
    ConversationStateService,
    ResponseConfidenceService,
    FraudSignalCollectorService,
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
    OutboxService,
    FeatureService,
    OrderIdempotencyService,
    ComplianceGuardService,
    KillSwitchService,
    FrustrationDetectorService,
    FraudDetectorService,
    ToolValidatorService,
    ObservabilityService,
    ImageRouterService,
    HandoffSlaService,
    ConversationStateMachine,
    ConversationStateService,
    ResponseConfidenceService,
    FraudSignalCollectorService,
    CustomerRegistryService,
  ],
})
export class CommonModule {}
