import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InboxModule } from '../inbox/inbox.module';
import { InternalChatController } from './internal-chat.controller';
import { InternalChatService } from './internal-chat.service';

// Reuses InboxGateway (exported by InboxModule) for socket delivery + presence.
// InternalChatModule → InboxModule → AuthModule; no path back, so no cycle.
@Module({
  imports: [AuthModule, InboxModule],
  controllers: [InternalChatController],
  providers: [InternalChatService],
})
export class InternalChatModule {}
