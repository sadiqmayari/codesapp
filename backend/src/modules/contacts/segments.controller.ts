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
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SegmentsService } from './segments.service';
import {
  CreateSegmentDto,
  SegmentPreviewQueryDto,
  UpdateSegmentDto,
} from './dto/create-segment.dto';

/**
 * Segments drive broadcast audiences, so create/edit/delete are owner/admin.
 * Reading (list/preview/count) stays open to every member — the broadcast
 * builder and contacts filter need it.
 */
@Controller('contacts/segments')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class SegmentsController {
  constructor(private readonly segmentsService: SegmentsService) {}

  @Get()
  list(@CurrentUser() user: { companyId: number }) {
    return this.segmentsService.list(user.companyId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  create(
    @CurrentUser() user: { companyId: number },
    @Body() dto: CreateSegmentDto,
  ) {
    return this.segmentsService.create(user.companyId, dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  update(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSegmentDto,
  ) {
    return this.segmentsService.update(user.companyId, id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  remove(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.segmentsService.delete(user.companyId, id);
  }

  @Get(':id/count')
  count(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.segmentsService.count(user.companyId, id);
  }

  @Get(':id/preview')
  preview(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Query() q: SegmentPreviewQueryDto,
  ) {
    return this.segmentsService.preview(user.companyId, id, q.limit ?? 20);
  }
}
