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
import { AiKnowledgeService } from './ai-knowledge.service';
import { CreateKnowledgeDto, UpdateKnowledgeDto } from './dto/knowledge.dto';

@Controller('ai/knowledge')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class AiKnowledgeController {
  constructor(private readonly knowledge: AiKnowledgeService) {}

  @Get()
  list(@CurrentUser() user: { companyId: number }) {
    return this.knowledge.list(user.companyId);
  }

  @Post()
  create(
    @CurrentUser() user: { companyId: number },
    @Body() dto: CreateKnowledgeDto,
  ) {
    return this.knowledge.create(user.companyId, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateKnowledgeDto,
  ) {
    return this.knowledge.update(user.companyId, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: { companyId: number },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.knowledge.remove(user.companyId, id);
  }
}
