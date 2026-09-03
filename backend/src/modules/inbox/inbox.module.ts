import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsageMeteringModule } from '../usage-metering/usage-metering.module';
import { BotsModule } from '../bots/bots.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
// InboxModule → AiModule is safe: AiModule imports only AuthModule (no path back
// to Inbox), so this does NOT form the AiModule→InboxModule cycle we avoid
// elsewhere. Gives the inbox on-demand voice-note transcription + AI metering.
import { AiModule } from '../ai/ai.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { InboxGateway } from './inbox.gateway';
import { MetaClientService } from './meta-client.service';
import { MetaWebhookController } from './meta-webhook.controller';
import { MetaWebhookService } from './meta-webhook.service';
import { WsJwtGuard } from './ws-jwt.guard';

@Module({
  imports: [
    AuthModule,
    UsageMeteringModule,
    WebhooksModule,
    AiModule,
    forwardRef(() => BotsModule),
    // (Inbox is also pulled by BillingModule via forwardRef so the
    // LimitNotifierService can emit `usage.warning` via InboxGateway.
    // No reciprocal forwardRef needed here — Nest resolves the cycle from
    // the side that declared forwardRef.)
  ],
  controllers: [InboxController, MetaWebhookController],
  providers: [
    InboxService,
    InboxGateway,
    MetaClientService,
    MetaWebhookService,
    WsJwtGuard,
  ],
  exports: [InboxService, InboxGateway, MetaClientService],
})
export class InboxModule {}
