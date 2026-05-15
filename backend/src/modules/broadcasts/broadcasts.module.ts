import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InboxModule } from '../inbox/inbox.module';
import { ContactsModule } from '../contacts/contacts.module';
import { BroadcastsController } from './broadcasts.controller';
import { BroadcastsService } from './broadcasts.service';
import { BroadcastWorker } from './broadcast.worker';
import { BroadcastPlanGuard } from './broadcast-plan.guard';

@Module({
  imports: [AuthModule, InboxModule, ContactsModule],
  controllers: [BroadcastsController],
  providers: [BroadcastsService, BroadcastWorker, BroadcastPlanGuard],
  exports: [BroadcastsService],
})
export class BroadcastsModule {}
