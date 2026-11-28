import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { INBOX_ROLES, PRIVILEGED, isPrivileged } from '../../common/auth/roles';
import { DashboardService } from './dashboard.service';
import { ForbiddenException } from '@nestjs/common';

class LayoutBody {
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  hidden!: string[];
}

class SetLayoutDto {
  /** null = forget my layout (follow the team default). */
  @IsOptional()
  @ValidateNested()
  @Type(() => LayoutBody)
  layout?: LayoutBody | null;

  /** Owner/admin only: save as the team default instead of my own. */
  @IsOptional()
  @IsBoolean()
  teamDefault?: boolean;
}

type Actor = { companyId: number; userId: number; role: string };

const DAY = 86_400_000;
function range(from?: string, to?: string) {
  const now = new Date();
  const p = (v: string | undefined, fb: Date) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : fb;
  };
  const t = p(to, now);
  let f = p(from, new Date(t.getTime() - DAY));
  if (f > t) f = new Date(t.getTime() - DAY);
  // Never more than ~13 months in one read.
  if (t.getTime() - f.getTime() > 400 * DAY) f = new Date(t.getTime() - 400 * DAY);
  return { f, t };
}

/**
 * Dashboard v3. Owner/admin get the business command centre; agents get their
 * own queue and numbers (`me`). Locked roles never reach either.
 */
@Controller('dashboard')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles(...INBOX_ROLES)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('manager')
  @Roles(...PRIVILEGED)
  manager(@CurrentUser() u: Actor, @Query('from') from?: string, @Query('to') to?: string) {
    const { f, t } = range(from, to);
    return this.dashboard.manager(u.companyId, f, t);
  }

  @Get('plan-access')
  @Roles(...PRIVILEGED)
  planAccess(@CurrentUser() u: Actor) {
    return this.dashboard.planAccess(u.companyId);
  }

  @Get('activity')
  @Roles(...PRIVILEGED)
  activity(@CurrentUser() u: Actor, @Query('before') before?: string) {
    const b = before ? new Date(before) : undefined;
    return this.dashboard.activity(u.companyId, b && !Number.isNaN(b.getTime()) ? b : undefined);
  }

  @Get('me')
  me(@CurrentUser() u: Actor) {
    return this.dashboard.me(u.companyId, u.userId);
  }

  @Get('layout')
  layout(@CurrentUser() u: Actor) {
    return this.dashboard.getLayout(u.companyId, u.userId);
  }

  @Put('layout')
  setLayout(@CurrentUser() u: Actor, @Body() dto: SetLayoutDto) {
    if (dto.teamDefault && !isPrivileged(u.role)) {
      throw new ForbiddenException('Only owners and admins can set the team default.');
    }
    return this.dashboard.setLayout(u.companyId, u.userId, dto.layout ?? null, !!dto.teamDefault);
  }
}
