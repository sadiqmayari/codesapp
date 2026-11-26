import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InboxModule } from '../inbox/inbox.module';
import { SocialCommentsController } from './social-comments.controller';
import { SocialCommentsService } from './social-comments.service';

/** Ad / social comments (TikTok ad comments first). Leaf module — nothing imports it. */
@Module({
  imports: [AuthModule, InboxModule],
  controllers: [SocialCommentsController],
  providers: [SocialCommentsService],
})
export class SocialCommentsModule {}
