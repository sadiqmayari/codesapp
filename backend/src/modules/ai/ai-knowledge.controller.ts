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
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ImportUrlDto, TestQuestionDto } from './dto/agent-profile.dto';
import { AiRagService } from './ai-rag.service';
import { AuthGuard } from '@nestjs/passport';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AiKnowledgeService } from './ai-knowledge.service';
import { CreateKnowledgeDto, UpdateKnowledgeDto } from './dto/knowledge.dto';

@Controller('ai/knowledge')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class AiKnowledgeController {
  constructor(
    private readonly knowledge: AiKnowledgeService,
    private readonly rag: AiRagService,
  ) {}

  @Get()
  list(@CurrentUser() user: { companyId: number }) {
    return this.knowledge.list(user.companyId);
  }

  /** Index status: company totals + per-store product/policy counts. */
  @Get('index-status')
  async indexStatus(@CurrentUser() user: { companyId: number }) {
    const [totals, byStore] = await Promise.all([
      this.rag.status(user.companyId),
      this.rag.statusByStore(user.companyId),
    ]);
    return { ...totals, byStore };
  }

  /** Import a public web page or a sitemap.xml (≤25 pages). */
  @Post('import-url')
  importUrl(@CurrentUser() user: { companyId: number }, @Body() dto: ImportUrlDto) {
    return this.knowledge.importUrl(user.companyId, dto.url);
  }

  /** Import a PDF / TXT / CSV / Markdown document. */
  @Post('import-file')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  importFile(
    @CurrentUser() user: { companyId: number },
    @UploadedFile()
    file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  ) {
    return this.knowledge.importDocument(user.companyId, file);
  }

  /** What the agent would retrieve for a question (no reply generated). */
  @Post('test')
  test(@CurrentUser() user: { companyId: number }, @Body() dto: TestQuestionDto) {
    return this.knowledge.testQuestion(user.companyId, dto.question, dto.storeId ?? null);
  }

  /** Re-embed every manual entry (owner/admin). */
  @Post('reindex')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  reindex(@CurrentUser() user: { companyId: number }) {
    return this.knowledge.reindexAll(user.companyId);
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
