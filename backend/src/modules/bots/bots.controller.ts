import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BotsService } from './bots.service';
import { CreateBotDto } from './dto/create-bot.dto';
import { UpdateBotDto } from './dto/update-bot.dto';

@Controller('bots')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class BotsController {
  constructor(private readonly botsService: BotsService) {}

  @Get()
  list(@CurrentUser() user: { companyId: number }) {
    return this.botsService.list(user.companyId);
  }

  @Get(':id')
  get(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.botsService.get(user.companyId, id);
  }

  @Post()
  create(
    @CurrentUser() user: { companyId: number },
    @Body() dto: CreateBotDto,
  ) {
    return this.botsService.create(user.companyId, dto);
  }

  // Stage a media file for a `send_media` action. Returns the web path + mime
  // + filename to embed in the action; the file is re-sent on each trigger.
  @Post('media')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 }, // hard cap above per-type limits
    }),
  )
  stageMedia(
    @CurrentUser() user: { companyId: number },
    @UploadedFile()
    file:
      | { buffer: Buffer; mimetype: string; originalname?: string; size: number }
      | undefined,
  ) {
    return this.botsService.stageMedia(user.companyId, file);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBotDto,
  ) {
    return this.botsService.update(user.companyId, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.botsService.delete(user.companyId, id);
  }

  @Patch(':id/toggle')
  toggle(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.botsService.toggle(user.companyId, id);
  }
}
