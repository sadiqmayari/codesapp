import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CannedRepliesService } from './canned-replies.service';
import { CreateCannedReplyDto } from './dto/create-canned-reply.dto';
import { UpdateCannedReplyDto } from './dto/update-canned-reply.dto';

@Controller('canned-replies')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class CannedRepliesController {
  constructor(private readonly cannedReplies: CannedRepliesService) {}

  @Get()
  list(@CurrentUser() user: { companyId: number }) {
    return this.cannedReplies.list(user.companyId);
  }

  @Post()
  create(
    @CurrentUser() user: { companyId: number },
    @Body() dto: CreateCannedReplyDto,
  ) {
    return this.cannedReplies.create(user.companyId, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCannedReplyDto,
  ) {
    return this.cannedReplies.update(user.companyId, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.cannedReplies.remove(user.companyId, id);
  }
}
