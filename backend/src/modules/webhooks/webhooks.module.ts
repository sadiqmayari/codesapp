import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookWorker } from './webhook.worker';

@Module({
  imports: [AuthModule],
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    WebhookDeliveryService,
    WebhookDispatcherService,
    WebhookWorker,
  ],
  exports: [WebhookDispatcherService],
})
export class WebhooksModule {}
