import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { GamificationController } from './gamification.controller';
import { GamificationService } from './gamification.service';

@Module({
  imports: [AuthModule, AnalyticsModule],
  controllers: [GamificationController],
  providers: [GamificationService],
})
export class GamificationModule {}
