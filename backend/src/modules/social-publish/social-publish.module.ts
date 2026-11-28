import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InboxModule } from '../inbox/inbox.module';
import { ContentModule } from '../content/content.module';
import { SocialPublishController } from './social-publish.controller';
import { SocialPublishService } from './social-publish.service';

/** Publish / schedule posts to Facebook Pages + Instagram. LEAF module. */
@Module({
  imports: [AuthModule, InboxModule, ContentModule],
  controllers: [SocialPublishController],
  providers: [SocialPublishService],
})
export class SocialPublishModule {}
