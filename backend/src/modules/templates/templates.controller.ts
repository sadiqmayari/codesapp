import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { PlanGuard } from '../../common/guards/plan.guard';
import { PlanLimit } from '../../common/decorators/plan-limit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { ListTemplatesDto } from './dto/list-templates.dto';

@Controller('templates')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Get()
  list(
    @CurrentUser() user: { companyId: number },
    @Query() dto: ListTemplatesDto,
  ) {
    return this.templatesService.list(user.companyId, dto);
  }

  @Get(':id')
  get(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.templatesService.get(user.companyId, id);
  }

  @Post()
  @UseGuards(PlanGuard)
  @PlanLimit('templates')
  create(
    @CurrentUser() user: { companyId: number },
    @Body() dto: CreateTemplateDto,
  ) {
    return this.templatesService.create(user.companyId, dto);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.templatesService.softDelete(user.companyId, id);
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  sync(@CurrentUser() user: { companyId: number }) {
    return this.templatesService.sync(user.companyId);
  }
}
