import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsageMeteringModule } from '../usage-metering/usage-metering.module';
import { InboxModule } from '../inbox/inbox.module';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { MetaTemplateSyncService } from './meta-template-sync.service';

@Module({
  imports: [AuthModule, UsageMeteringModule, InboxModule],
  controllers: [TemplatesController],
  providers: [TemplatesService, MetaTemplateSyncService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
