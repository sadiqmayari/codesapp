import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CannedRepliesController } from './canned-replies.controller';
import { CannedRepliesService } from './canned-replies.service';

@Module({
  imports: [AuthModule],
  controllers: [CannedRepliesController],
  providers: [CannedRepliesService],
})
export class CannedRepliesModule {}
