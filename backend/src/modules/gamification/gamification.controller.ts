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
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { GamificationService } from './gamification.service';
import { CreateContestDto, UpdateContestDto } from './dtos/contest.dto';
import { SetTargetDto } from './dtos/target.dto';
import { UpdateGameConfigDto } from './dtos/config.dto';

type Actor = { userId: number; companyId: number; role: string };

const DEFAULT_RANGE_DAYS = 7;

@Controller('gamification')
@UseGuards(AuthGuard('jwt'), TenantGuard)
export class GamificationController {
  constructor(private readonly gamification: GamificationService) {}

  // -------- read (any authenticated tenant user, agents included) --------
  @Get('leaderboard')
  leaderboard(
    @CurrentUser() user: Actor,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const now = new Date();
    const parse = (v: string | undefined, fallback: Date) => {
      const d = v ? new Date(v) : null;
      return d && !Number.isNaN(d.getTime()) ? d : fallback;
    };
    const toDate = parse(to, now);
    const fromDate = parse(
      from,
      new Date(toDate.getTime() - DEFAULT_RANGE_DAYS * 86_400_000),
    );
    return this.gamification.leaderboard(user.companyId, fromDate, toDate);
  }

  @Get('contests')
  contests(@CurrentUser() user: Actor) {
    return this.gamification.contests(user);
  }

  @Get('targets')
  targets(@CurrentUser() user: Actor) {
    return this.gamification.targets(user);
  }

  @Get('settings')
  settings(@CurrentUser() user: Actor) {
    return this.gamification.getConfig(user.companyId);
  }

  // -------- admin (owner/admin only) --------
  @Patch('settings')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  updateSettings(@CurrentUser() user: Actor, @Body() dto: UpdateGameConfigDto) {
    return this.gamification.updateConfig(user.companyId, dto);
  }

  @Post('contests')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  createContest(@CurrentUser() user: Actor, @Body() dto: CreateContestDto) {
    return this.gamification.createContest(user, dto);
  }

  @Patch('contests/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  updateContest(
    @CurrentUser() user: Actor,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateContestDto,
  ) {
    return this.gamification.updateContest(user, id, dto);
  }

  @Delete('contests/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  deleteContest(
    @CurrentUser() user: Actor,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.gamification.deleteContest(user, id);
  }

  @Post('targets')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  setTarget(@CurrentUser() user: Actor, @Body() dto: SetTargetDto) {
    return this.gamification.setTarget(user, dto);
  }

  @Delete('targets/:id')
  @UseGuards(RolesGuard)
  @Roles('owner', 'admin')
  deleteTarget(
    @CurrentUser() user: Actor,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.gamification.deleteTarget(user, id);
  }
}
