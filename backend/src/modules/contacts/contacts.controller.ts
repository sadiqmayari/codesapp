import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { PlanGuard } from '../../common/guards/plan.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { PlanLimit } from '../../common/decorators/plan-limit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ContactsService } from './contacts.service';
import { CsvImportService, ImportMode } from './csv-import.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { ListContactsDto } from './dto/list-contacts.dto';
import { BulkContactsDto, MergeContactsDto } from './dto/bulk-contacts.dto';

interface UploadedCsvFile {
  buffer: Buffer;
  size: number;
  originalname: string;
  mimetype: string;
}

type ReqUser = { companyId: number; userId: number; role: string };

const CSV_MAX_BYTES = 5 * 1024 * 1024; // 5MB

const actor = (u: ReqUser) => ({ companyId: u.companyId, userId: u.userId, role: u.role });

/**
 * Contacts 360. RBAC: every member can list/view/create/edit (agents tag and
 * block from the inbox). Destructive or mass operations — delete, restore,
 * import, export, bulk, merge — are owner/admin. Phone changes are checked in
 * the service (owner/admin).
 *
 * Static routes are declared BEFORE `:id` so e.g. `export` isn't parsed as an id.
 */
@Controller('contacts')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class ContactsController {
  constructor(
    private readonly contactsService: ContactsService,
    private readonly csvImport: CsvImportService,
  ) {}

  @Get()
  list(@CurrentUser() user: ReqUser, @Query() dto: ListContactsDto) {
    return this.contactsService.list(user.companyId, dto, actor(user));
  }

  @Get('tags')
  tags(@CurrentUser() user: ReqUser) {
    return this.contactsService.distinctTags(user.companyId);
  }

  @Get('export')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  async export(
    @CurrentUser() user: ReqUser,
    @Query() dto: ListContactsDto,
    @Res() res: Response,
  ) {
    const csv = await this.contactsService.exportCsv(user.companyId, dto, actor(user));
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-${day}.csv"`);
    res.send(csv);
  }

  @Get('duplicates')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  duplicates(@CurrentUser() user: ReqUser) {
    return this.contactsService.duplicates(user.companyId);
  }

  @Post('merge')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  merge(@CurrentUser() user: ReqUser, @Body() dto: MergeContactsDto) {
    return this.contactsService.merge(user.companyId, dto, actor(user));
  }

  @Post('bulk')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  bulk(@CurrentUser() user: ReqUser, @Body() dto: BulkContactsDto) {
    return this.contactsService.bulk(user.companyId, dto, actor(user));
  }

  @Post('import')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: CSV_MAX_BYTES } }),
  )
  async import(
    @CurrentUser() user: ReqUser,
    @UploadedFile() file: UploadedCsvFile,
    @Body('mode') mode?: string,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('CSV file is required');
    }
    const m: ImportMode = mode === 'update' ? 'update' : 'skip';
    return this.csvImport.import(user.companyId, file.buffer, m, user.userId);
  }

  @Get('import/:jobId')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  importJob(@CurrentUser() user: ReqUser, @Param('jobId') jobId: string) {
    return this.csvImport.getJob(user.companyId, jobId);
  }

  @Post()
  @UseGuards(PlanGuard)
  @PlanLimit('contacts')
  create(@CurrentUser() user: ReqUser, @Body() dto: CreateContactDto) {
    return this.contactsService.create(user.companyId, dto, actor(user));
  }

  @Get(':id')
  get(@CurrentUser() user: ReqUser, @Param('id', ParseIntPipe) id: number) {
    return this.contactsService.get(user.companyId, id);
  }

  @Get(':id/overview')
  overview(@CurrentUser() user: ReqUser, @Param('id', ParseIntPipe) id: number) {
    return this.contactsService.overview(user.companyId, id);
  }

  @Post(':id/conversation')
  conversation(@CurrentUser() user: ReqUser, @Param('id', ParseIntPipe) id: number) {
    return this.contactsService.ensureConversation(user.companyId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: ReqUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateContactDto,
  ) {
    return this.contactsService.update(user.companyId, id, dto, actor(user));
  }

  @Post(':id/restore')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  restore(@CurrentUser() user: ReqUser, @Param('id', ParseIntPipe) id: number) {
    return this.contactsService.restore(user.companyId, id, actor(user));
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  remove(@CurrentUser() user: ReqUser, @Param('id', ParseIntPipe) id: number) {
    return this.contactsService.softDelete(user.companyId, id, actor(user));
  }
}
