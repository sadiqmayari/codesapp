import {
  Body,
  Controller,
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
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ModuleGuard } from '../../common/guards/module.guard';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SocialPublishService } from './social-publish.service';

/** Owners/admins + the content team that plans and approves posts. */
const POST_ROLES = ['owner', 'admin', 'creative_executive', 'social_media_executive', 'content_manager'] as const;

class MediaDto {
  @IsString() @MaxLength(500) webPath!: string;
  @IsIn(['image', 'video']) type!: 'image' | 'video';
  @IsOptional() @IsString() @MaxLength(100) mime?: string;
}
class TargetDto {
  @Type(() => Number) @IsInt() metaPageId!: number;
  @IsIn(['facebook', 'instagram']) platform!: 'facebook' | 'instagram';
}
class CreatePostDto {
  @IsString() @MaxLength(63206) caption!: string;
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => MediaDto) media!: MediaDto[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => TargetDto) targets!: TargetDto[];
  @IsOptional() @IsString() scheduledAt?: string | null;
}
class FromContentDto {
  @IsOptional() @IsString() @MaxLength(63206) caption?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => TargetDto) targets!: TargetDto[];
  @IsOptional() @IsString() scheduledAt?: string | null;
}

type U = { companyId: number; userId: number };

@Controller('social-posts')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard, ModuleGuard)
@Roles(...POST_ROLES)
@RequireModule('social_publish')
export class SocialPublishController {
  constructor(private readonly svc: SocialPublishService) {}

  @Get('accounts')
  accounts(@CurrentUser() u: U) {
    return this.svc.accounts(u.companyId);
  }

  @Post('media')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 105 * 1024 * 1024 } }))
  upload(
    @CurrentUser() u: U,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; originalname?: string; size: number },
  ) {
    return this.svc.uploadMedia(u.companyId, file);
  }

  @Post('from-content/:contentId')
  fromContent(@CurrentUser() u: U, @Param('contentId', ParseIntPipe) contentId: number, @Body() dto: FromContentDto) {
    return this.svc.fromContent(u.companyId, u.userId, contentId, dto);
  }

  @Get()
  list(@CurrentUser() u: U, @Query('tab') tab?: string, @Query('page') page?: string) {
    return this.svc.list(u.companyId, tab, Number(page) || 1);
  }

  @Get(':id')
  get(@CurrentUser() u: U, @Param('id', ParseIntPipe) id: number) {
    return this.svc.get(u.companyId, id);
  }

  @Post()
  create(@CurrentUser() u: U, @Body() dto: CreatePostDto) {
    return this.svc.create(u.companyId, u.userId, dto);
  }

  @Patch(':id')
  update(@CurrentUser() u: U, @Param('id', ParseIntPipe) id: number, @Body() dto: CreatePostDto) {
    return this.svc.update(u.companyId, u.userId, id, dto);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() u: U, @Param('id', ParseIntPipe) id: number) {
    return this.svc.cancel(u.companyId, u.userId, id);
  }

  @Post(':id/retry')
  retry(@CurrentUser() u: U, @Param('id', ParseIntPipe) id: number) {
    return this.svc.retry(u.companyId, u.userId, id);
  }
}
