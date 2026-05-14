import { Module } from '@nestjs/common';
import { UsageMeteringService } from './usage-metering.service';

@Module({
  providers: [UsageMeteringService],
  exports: [UsageMeteringService],
})
export class UsageMeteringModule {}
