import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InboxModule } from '../inbox/inbox.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  imports: [AuthModule, InboxModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
