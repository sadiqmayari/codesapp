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
  AssignContentDto,
  CreateCollectionDto,
  CreateContentDto,
  CreatePlanDto,
  CreatePlanBulkDto,
  ReviewContentDto,
  ScheduleContentDto,
  UpdateCollectionDto,
} from './dto/content.dto';

type CU = { companyId: number; userId: number; role: string };

// Who can plan / assign / upload-new / delete content (the "managers").
const MANAGE_ROLES = ['owner', 'admin', 'creative_executive', 'content_manager'];
// Who can attach media (managers + the two uploader roles).
const UPLOAD_ROLES = [...MANAGE_ROLES, 'videographer', 'graphic_designer'];
// Who may SEE the Content module at all (class-level gate). Agents / finance /
// fulfillment are deliberately excluded — the module is for the creative team.
const VIEW_ROLES = UPLOAD_ROLES;

@Controller('content')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles(...VIEW_ROLES)
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
    return this.content.list(user.companyId, status, {
      userId: user.userId,
      role: user.role,
    });
  }

  @Get('assignees')
  @UseGuards(RolesGuard)
  @Roles(...MANAGE_ROLES)
  async assignees(@CurrentUser() user: CU) {
    await this.content.assertEnabled(user.companyId);
    return this.content.listAssignees(user.companyId);
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

  // ── Collections: campaigns + folders ────────────────────────────────────────
  // (Declared before the `:id` routes so "collections" isn't parsed as an id.)
  @Get('collections')
  async listCollections(
    @CurrentUser() user: CU,
    @Query('includeArchived') includeArchived?: string,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.listCollections(
      user.companyId,
      includeArchived === '1' || includeArchived === 'true',
    );
  }

  @Post('collections')
  @UseGuards(RolesGuard)
  @Roles(...MANAGE_ROLES)
  async createCollection(
    @CurrentUser() user: CU,
    @Body() dto: CreateCollectionDto,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.createCollection(user.companyId, user.userId, dto);
  }

  @Patch('collections/:id')
  @UseGuards(RolesGuard)
  @Roles(...MANAGE_ROLES)
  async updateCollection(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCollectionDto,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.updateCollection(user.companyId, id, dto);
  }

  @Delete('collections/:id')
  @UseGuards(RolesGuard)
  @Roles(...MANAGE_ROLES)
  async removeCollection(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.removeCollection(user.companyId, id);
  }

  @Post('plan')
  @UseGuards(RolesGuard)
  @Roles(...MANAGE_ROLES)
  async plan(@CurrentUser() user: CU, @Body() dto: CreatePlanDto) {
    await this.content.assertEnabled(user.companyId);
    return this.content.createPlan(user.companyId, user.userId, dto);
  }

  @Post('plan/bulk')
  @UseGuards(RolesGuard)
  @Roles(...MANAGE_ROLES)
  async planBulk(@CurrentUser() user: CU, @Body() dto: CreatePlanBulkDto) {
    await this.content.assertEnabled(user.companyId);
    return this.content.createPlanBulk(user.companyId, user.userId, dto.items);
  }

  @Post('upload')
  @UseGuards(RolesGuard)
  @Roles(...MANAGE_ROLES)
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
  @Roles(...UPLOAD_ROLES)
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
    return this.content.attachMedia(user.companyId, id, file, {
      userId: user.userId,
      role: user.role,
    });
  }

  @Post(':id/reference')
  @Roles(...MANAGE_ROLES)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 150 * 1024 * 1024 } }),
  )
  async attachReference(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile()
    file:
      | { buffer: Buffer; mimetype: string; originalname?: string; size: number }
      | undefined,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.attachReference(user.companyId, id, file);
  }

  @Delete(':id/reference')
  @Roles(...MANAGE_ROLES)
  async removeReference(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.removeReference(user.companyId, id);
  }

  @Patch(':id/assign')
  @UseGuards(RolesGuard)
  @Roles(...MANAGE_ROLES)
  async assign(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignContentDto,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.assign(user.companyId, id, dto, user.userId);
  }

  @Get(':id/events')
  async events(@CurrentUser() user: CU, @Param('id', ParseIntPipe) id: number) {
    await this.content.assertEnabled(user.companyId);
    return this.content.getEvents(user.companyId, id, {
      userId: user.userId,
      role: user.role,
    });
  }

  @Get(':id')
  async get(@CurrentUser() user: CU, @Param('id', ParseIntPipe) id: number) {
    await this.content.assertEnabled(user.companyId);
    return this.content.get(user.companyId, id, {
      userId: user.userId,
      role: user.role,
    });
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
  @Roles(...MANAGE_ROLES)
  async schedule(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ScheduleContentDto,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.schedule(user.companyId, id, dto, user.userId);
  }

  @Patch(':id/publish')
  @Roles(...MANAGE_ROLES)
  async publish(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.markPublished(user.companyId, id, user.userId);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(...MANAGE_ROLES)
  async remove(
    @CurrentUser() user: CU,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.content.assertEnabled(user.companyId);
    return this.content.remove(user.companyId, id, user.userId);
  }
}
