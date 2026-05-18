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
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { TeamService } from './team.service';
import { CreateTeamMemberDto } from './dto/create-team-member.dto';
import { UpdateTeamMemberDto } from './dto/update-team-member.dto';

type Actor = { userId: number; companyId: number; role: string };

@Controller('team')
@UseGuards(AuthGuard('jwt'), TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class TeamController {
  constructor(private readonly teamService: TeamService) {}

  @Get()
  list(@CurrentUser() user: Actor) {
    return this.teamService.list(user.companyId);
  }

  @Post()
  create(@CurrentUser() user: Actor, @Body() dto: CreateTeamMemberDto) {
    return this.teamService.create(user.companyId, user.role, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: Actor,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTeamMemberDto,
  ) {
    return this.teamService.update(
      user.companyId,
      user.userId,
      user.role,
      id,
      dto,
    );
  }

  @Delete(':id')
  suspend(
    @CurrentUser() user: Actor,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.teamService.suspend(user.companyId, user.userId, id);
  }
}
