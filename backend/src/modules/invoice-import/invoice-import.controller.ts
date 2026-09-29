import {
  BadRequestException,
  Controller,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FilesInterceptor } from '@nestjs/platform-express';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { InvoiceImportService } from './invoice-import.service';

/**
 * Tenant-facing invoice-import upload (Settings → Invoice import). Owner/admin
 * only. Accepts multiple statement files (.xls/.xlsx/.csv), parses each with the
 * tenant's super-admin-configured format, and stamps the courier invoice number
 * onto matching orders. The feature/format gate lives in the service.
 */
@Controller('settings/invoice-import')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles('owner', 'admin', 'finance')
export class InvoiceImportController {
  constructor(private readonly service: InvoiceImportService) {}

  @Post()
  @UseInterceptors(FilesInterceptor('files', 20, { limits: { fileSize: 15 * 1024 * 1024 } }))
  import(
    @CurrentUser() user: { companyId: number },
    @UploadedFiles() files: Array<{ buffer: Buffer; originalname: string }>,
  ) {
    if (!files?.length) throw new BadRequestException('No files uploaded.');
    return this.service.import(
      user.companyId,
      files.map((f) => ({ buffer: f.buffer, originalname: f.originalname })),
    );
  }
}
