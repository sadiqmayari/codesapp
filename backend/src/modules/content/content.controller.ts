import {
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
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ContentService } from './content.service';
import {
  CreateContentDto,
  CreatePlanDto,
  CreatePlanBulkDto,
  ReviewContentDto,
  ScheduleContentDto,
} from './dto/content.dto';

type CU = { companyId: number; userId: number; role: string };

@Controller('content')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class ContentController {
  constructor(private readonly content: ContentService) {}

  // ── Drive connection (owner/admin only) ────────────────────────────────────
  @Get('drive/status')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  async driveStatus(@CurrentUser() user: CU) {
    await this.content.assertEnabled(user.companyId);
    return this.content.driveStatus(user.companyId);
  }

  @Get('drive/connect')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  async driveConnect(@CurrentUser() user: CU) {
    await this.content.assertEnabled(user.companyId);
    return this.content.driveConnectUrl(user.companyId);
  }

  @Post('drive/disconnect')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  async driveDisconnect(@CurrentUser() user: CU) {
    await this.content.assertEnabled(user.companyId);
    return this.content.driveDisconnect(user.companyId);
  }

  // ── Content items ───────────────────────────────────────────────────────────
  @Get()
  async list(@CurrentUser() user: CU, @Query('status') status?: string) {
    await this.content.assertEnabled(user.companyId);
    return this.content.list(user.companyId, status);
  }

  @Get('calendar')
  async calendar(
    @CurrentUser() user: CU,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    await this.content.assertEnabled(user.companyId);
    const now = new Date();
    const start = from
      ? new Date(from)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    const end = to
      ? new Date(to)
      : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    return this.content.calendar(user.companyId, start, end);
  }

  @Get('stats')
  async stats(@CurrentUser() user: CU) {
    await this.content.assertEnabled(user.companyId);
    return this.content.stats(user.companyId);
  }

  @Post('plan')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'content_manager')
  async plan(@CurrentUser() user: CU, @Body() dto: CreatePlanDto) {
    await this.content.assertEnabled(user.companyId);
    return this.content.createPlan(user.companyId, user.userId, dto);
  }

  @Post('plan/bulk')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'content_manager')
  async planBulk(@CurrentUser() user: CU, @Body() dto: CreatePlanBulkDto) {
    await this.content.assertEnabled(user.companyId);
    return this.content.createPlanBulk(user.companyId, user.userId, dto.items);
  }

  @Post('upload')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'content_manager')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 150 * 1024 * 1024 } }),
  )
  async upload(
    @CurrentUser() user: CU,
    @UploadedFile()
    file:
      | {
          buffer: Buffer;
          mimetype: string;
          originalname?: string;
          size: number;
        }
      | undefined,
    @Body() dto: CreateContentDto,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.createUpload(user.companyId, user.userId, file, dto);
  }

  @Post(':id/media')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'content_manager')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 150 * 1024 * 1024 } }),
  )
  async attachMedia(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile()
    file:
      | {
          buffer: Buffer;
          mimetype: string;
          originalname?: string;
          size: number;
        }
      | undefined,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.attachMedia(user.companyId, id, file);
  }

  @Get(':id')
  async get(@CurrentUser() user: CU, @Param('id', ParseIntPipe) id: number) {
    await this.content.assertEnabled(user.companyId);
    return this.content.get(user.companyId, id);
  }

  @Patch(':id/review')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  async review(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewContentDto,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.review(user.companyId, id, dto, user.userId);
  }

  @Patch(':id/schedule')
  async schedule(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ScheduleContentDto,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.schedule(user.companyId, id, dto);
  }

  @Patch(':id/publish')
  async publish(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.markPublished(user.companyId, id);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin', 'content_manager')
  async remove(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.remove(user.companyId, id);
  }
}
