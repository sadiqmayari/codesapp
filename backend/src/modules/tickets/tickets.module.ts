import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InboxModule } from '../inbox/inbox.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  // InboxModule gives TicketsService InboxService to send the customer an
  // auto-acknowledgement (with the ticket number) when a ticket is opened.
  // One-way dep (Inbox/Bots don't import Tickets) — no cycle.
  imports: [AuthModule, InboxModule],
  controllers: [TicketsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
