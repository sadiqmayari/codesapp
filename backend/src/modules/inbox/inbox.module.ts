import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsageMeteringModule } from '../usage-metering/usage-metering.module';
import { BotsModule } from '../bots/bots.module';
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
    forwardRef(() => BotsModule),
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
