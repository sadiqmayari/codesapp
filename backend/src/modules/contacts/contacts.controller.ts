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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { PlanGuard } from '../../common/guards/plan.guard';
import { PlanLimit } from '../../common/decorators/plan-limit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ContactsService } from './contacts.service';
import { CsvImportService } from './csv-import.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { ListContactsDto } from './dto/list-contacts.dto';

interface UploadedCsvFile {
  buffer: Buffer;
  size: number;
  originalname: string;
  mimetype: string;
}

const CSV_MAX_BYTES = 5 * 1024 * 1024; // 5MB

@Controller('contacts')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class ContactsController {
  constructor(
    private readonly contactsService: ContactsService,
    private readonly csvImport: CsvImportService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: { companyId: number },
    @Query() dto: ListContactsDto,
  ) {
    return this.contactsService.list(user.companyId, dto);
  }

  @Get('tags')
  tags(@CurrentUser() user: { companyId: number }) {
    return this.contactsService.distinctTags(user.companyId);
  }

  @Get(':id')
  get(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.contactsService.get(user.companyId, id);
  }

  @Post()
  @UseGuards(PlanGuard)
  @PlanLimit('contacts')
  create(
    @CurrentUser() user: { companyId: number },
    @Body() dto: CreateContactDto,
  ) {
    return this.contactsService.create(user.companyId, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateContactDto,
  ) {
    return this.contactsService.update(user.companyId, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.contactsService.softDelete(user.companyId, id);
  }

  @Post('import')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: CSV_MAX_BYTES } }),
  )
  async import(
    @CurrentUser() user: { companyId: number },
    @UploadedFile() file: UploadedCsvFile,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('CSV file is required');
    }
    if (file.size > CSV_MAX_BYTES) {
      throw new BadRequestException('CSV file exceeds 5MB limit');
    }
    return this.csvImport.import(user.companyId, file.buffer);
  }
}
