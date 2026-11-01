import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InboxModule } from '../inbox/inbox.module';
import { CallsService } from './calls.service';
import { CallsController } from './calls.controller';
import { CallsWebhookController } from './calls-webhook.controller';

/**
 * WhatsApp Business Calling (self-hosted Asterisk SIP).
 * AuthModule = jwt strategy for the authed endpoints. InboxModule exports
 * InboxGateway (scoped socket emit) + InboxService (RBAC access check).
 * PrismaService + ConfigService are global.
 */
@Module({
  imports: [AuthModule, InboxModule],
  controllers: [CallsController, CallsWebhookController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
