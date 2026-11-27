import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ModuleGuard } from '../../common/guards/module.guard';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { INBOX_ROLES, PRIVILEGED } from '../../common/auth/roles';
import { SocialCommentsService } from './social-comments.service';

type U = { companyId: number; userId: number };

class ListCommentsDto {
  @IsOptional() @IsIn(['tiktok', 'youtube', 'meta', 'instagram']) platform?: string;
  @IsOptional() @IsIn(['visible', 'hidden', 'unreplied', 'all']) status?: 'visible' | 'hidden' | 'unreplied' | 'all';
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

class ReplyDto {
  @IsString() @MinLength(1) @MaxLength(500) text!: string;
}

@Controller('social-comments')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard, ModuleGuard)
@Roles(...INBOX_ROLES)
@RequireModule('social_comments')
export class SocialCommentsController {
  constructor(private readonly comments: SocialCommentsService) {}

  @Get()
  list(@CurrentUser() u: U, @Query() q: ListCommentsDto) {
    return this.comments.list(u.companyId, q);
  }

  @Post('refresh')
  @Roles(...PRIVILEGED)
  refresh(@CurrentUser() u: U) {
    return this.comments.refresh(u.companyId);
  }

  @Post(':id/reply')
  reply(@CurrentUser() u: U, @Param('id', ParseIntPipe) id: number, @Body() dto: ReplyDto) {
    return this.comments.reply(u.companyId, u.userId, id, dto.text);
  }

  @Post(':id/hide')
  hide(@CurrentUser() u: U, @Param('id', ParseIntPipe) id: number) {
    return this.comments.setHidden(u.companyId, u.userId, id, true);
  }

  @Post(':id/unhide')
  unhide(@CurrentUser() u: U, @Param('id', ParseIntPipe) id: number) {
    return this.comments.setHidden(u.companyId, u.userId, id, false);
  }
}
