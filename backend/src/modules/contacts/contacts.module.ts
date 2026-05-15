import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsageMeteringModule } from '../usage-metering/usage-metering.module';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { CsvImportService } from './csv-import.service';
import { SegmentsController } from './segments.controller';
import { SegmentsService } from './segments.service';

@Module({
  imports: [AuthModule, UsageMeteringModule],
  controllers: [SegmentsController, ContactsController],
  providers: [ContactsService, CsvImportService, SegmentsService],
  exports: [ContactsService, SegmentsService],
})
export class ContactsModule {}
