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
