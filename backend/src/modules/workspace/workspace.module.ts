import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InboxModule } from '../inbox/inbox.module';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';

// WorkspaceModule → InboxModule → AuthModule (no path back to Workspace), so
// this is a safe one-way dependency for reusing MetaClientService.
@Module({
  imports: [AuthModule, InboxModule],
  controllers: [WorkspaceController],
  providers: [WorkspaceService],
})
export class WorkspaceModule {}
