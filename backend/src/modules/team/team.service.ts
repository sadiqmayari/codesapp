import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTeamMemberDto } from './dto/create-team-member.dto';
import { UpdateTeamMemberDto } from './dto/update-team-member.dto';

const BCRYPT_ROUNDS = 12;

const SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  created_at: true,
} as const;

@Injectable()
export class TeamService {
  constructor(private readonly prisma: PrismaService) {}

  list(companyId: number) {
    return this.prisma.user.findMany({
      where: { company_id: companyId },
      select: SELECT,
      orderBy: { created_at: 'asc' },
    });
  }

  async create(
    companyId: number,
    actorRole: string,
    dto: CreateTeamMemberDto,
  ) {
    // Only an owner may create an admin; admins can only create agents.
    if (dto.role === 'admin' && actorRole !== 'owner') {
      throw new ForbiddenException('Only the owner can create admins');
    }

    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    await this.assertUnderUserLimit(companyId);

    const password_hash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    return this.prisma.user.create({
      data: {
        company_id: companyId,
        name: dto.name.trim(),
        email,
        password_hash,
        role: dto.role,
        status: 'active',
      },
      select: SELECT,
    });
  }

  async update(
    companyId: number,
    actorUserId: number,
    actorRole: string,
    targetId: number,
    dto: UpdateTeamMemberDto,
  ) {
    const target = await this.requireMember(companyId, targetId);
    if (target.id === actorUserId) {
      throw new BadRequestException('You cannot modify your own membership');
    }
    if (target.role === 'owner') {
      throw new ForbiddenException('The owner cannot be modified');
    }
    if (dto.role === 'admin' && actorRole !== 'owner') {
      throw new ForbiddenException('Only the owner can promote to admin');
    }

    // Re-activating from suspended counts against the plan again.
    if (dto.status === 'active' && target.status !== 'active') {
      await this.assertUnderUserLimit(companyId);
    }

    return this.prisma.user.update({
      where: { id: targetId },
      data: {
        ...(dto.role ? { role: dto.role } : {}),
        ...(dto.status ? { status: dto.status } : {}),
      },
      select: SELECT,
    });
  }

  async suspend(companyId: number, actorUserId: number, targetId: number) {
    const target = await this.requireMember(companyId, targetId);
    if (target.id === actorUserId) {
      throw new BadRequestException('You cannot remove yourself');
    }
    if (target.role === 'owner') {
      throw new ForbiddenException('The owner cannot be removed');
    }
    return this.prisma.user.update({
      where: { id: targetId },
      data: { status: 'suspended' },
      select: SELECT,
    });
  }

  private async requireMember(companyId: number, id: number) {
    const user = await this.prisma.user.findFirst({
      where: { id, company_id: companyId },
    });
    if (!user) throw new NotFoundException('Team member not found');
    return user;
  }

  private async assertUnderUserLimit(companyId: number) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: { subscription: true },
    });
    const limit = company?.subscription?.user_limit ?? 0;
    if (limit <= 0) return; // no plan limit configured → don't block
    const active = await this.prisma.user.count({
      where: { company_id: companyId, status: { not: 'suspended' } },
    });
    if (active >= limit) {
      throw new ForbiddenException(
        `Plan user limit reached (${active}/${limit}). Upgrade your plan or suspend a member.`,
      );
    }
  }
}
