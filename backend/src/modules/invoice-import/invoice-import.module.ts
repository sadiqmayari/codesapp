import { Module } from '@nestjs/common';
import { InvoiceImportController } from './invoice-import.controller';
import { InvoiceImportService } from './invoice-import.service';

// PrismaModule is @Global — PrismaService is injectable without importing it.
@Module({
  controllers: [InvoiceImportController],
  providers: [InvoiceImportService],
  exports: [InvoiceImportService],
})
export class InvoiceImportModule {}
