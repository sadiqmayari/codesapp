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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SegmentsService } from './segments.service';
import {
  CreateSegmentDto,
  UpdateSegmentDto,
} from './dto/create-segment.dto';

@Controller('contacts/segments')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class SegmentsController {
  constructor(private readonly segmentsService: SegmentsService) {}

  @Get()
  list(@CurrentUser() user: { companyId: number }) {
    return this.segmentsService.list(user.companyId);
  }

  @Post()
  create(
    @CurrentUser() user: { companyId: number },
    @Body() dto: CreateSegmentDto,
  ) {
    return this.segmentsService.create(user.companyId, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSegmentDto,
  ) {
    return this.segmentsService.update(user.companyId, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.segmentsService.delete(user.companyId, id);
  }

  @Get(':id/preview')
  preview(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Query('limit') limit?: string,
  ) {
    return this.segmentsService.preview(
      user.companyId,
      id,
      limit ? Number(limit) : 20,
    );
  }
}
