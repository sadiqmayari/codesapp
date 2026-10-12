import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InboxModule } from '../inbox/inbox.module';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';

// InboxModule is imported for InboxService.reassignConversations (move a
// departing agent's chats). Safe: TeamModule is a leaf (only AppModule pulls it),
// and nothing in InboxModule's graph imports TeamModule → no cycle.
@Module({
  imports: [AuthModule, InboxModule],
  controllers: [TeamController],
  providers: [TeamService],
})
export class TeamModule {}
