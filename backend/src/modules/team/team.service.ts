import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service';
import { InboxService } from '../inbox/inbox.service';
import { CreateTeamMemberDto } from './dto/create-team-member.dto';
import { UpdateTeamMemberDto } from './dto/update-team-member.dto';
import { resolveEffectiveLimits } from '../../common/utils/effective-limits';
import { teamManageError } from '../../common/auth/roles';
import { InboxGateway } from '../inbox/inbox.gateway';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly inbox: InboxService,
    private readonly gateway: InboxGateway,
  ) {}

  /** Throws when the actor may not manage this target / give it this role. */
  private assertCanManage(actorRole: string, targetRole: string | null, newRole?: string | null) {
    const err = teamManageError(actorRole, targetRole, newRole);
    if (err) throw new ForbiddenException(err);
  }

  /** Revoke every session of a user: bump token_version + drop live sockets. */
  private async revokeSessions(userId: number) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { token_version: { increment: 1 } },
    });
    await this.gateway.disconnectUser(userId);
  }

  list(companyId: number) {
    return this.prisma.user.findMany({
      where: { company_id: companyId, role: { not: 'super_admin' } },
      select: SELECT,
      orderBy: { created_at: 'asc' },
    });
  }

  async create(
    companyId: number,
    actorRole: string,
    dto: CreateTeamMemberDto,
  ) {
    // Owner creates anyone; admin anyone but admins; HR only non-privileged roles.
    this.assertCanManage(actorRole, null, dto.role);

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
    this.assertCanManage(actorRole, target.role, dto.role ?? null);

    // Re-activating from suspended counts against the plan again.
    if (dto.status === 'active' && target.status !== 'active') {
      await this.assertUnderUserLimit(companyId);
    }

    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data: {
        ...(dto.role ? { role: dto.role } : {}),
        ...(dto.status ? { status: dto.status } : {}),
      },
      select: SELECT,
    });
    // A role change or a suspend revokes live sessions so the new access applies
    // everywhere at once (HTTP already re-reads role per request).
    if ((dto.role && dto.role !== target.role) || (dto.status === 'suspended' && target.status !== 'suspended')) {
      await this.revokeSessions(targetId);
    }
    return updated;
  }

  /**
   * Suspend (deactivate) a member — their JWT stops validating immediately.
   * `reassignToUserId` controls what happens to the chats still assigned to them:
   *   - a user id → move all their conversations to that ACTIVE member;
   *   - null / omitted → release them back into the unassigned pool.
   * Either way the departing agent's chats never stay stranded on a suspended
   * user (invisible to everyone else under the pool model).
   */
  async suspend(
    companyId: number,
    actorUserId: number,
    actorRole: string,
    targetId: number,
    reassignToUserId?: number | null,
  ) {
    const target = await this.requireMember(companyId, targetId);
    if (target.id === actorUserId) {
      throw new BadRequestException('You cannot remove yourself');
    }
    this.assertCanManage(actorRole, target.role);
    // Reassign/unassign BEFORE suspending so the target validation (which
    // requires an active user) is unaffected by this member's new status.
    const { count } = await this.inbox.reassignConversations(
      companyId,
      targetId,
      reassignToUserId ?? null,
    );
    const user = await this.prisma.user.update({
      where: { id: targetId },
      data: { status: 'suspended' },
      select: SELECT,
    });
    await this.revokeSessions(targetId);
    return { ...user, reassignedChats: count };
  }

  /**
   * PERMANENTLY delete a member — the row is gone, not just suspended. Use only
   * when the member is leaving for good; suspend is the reversible option.
   * We first reassign/release their chats (same as suspend), then clear every
   * reference that would otherwise block the delete or orphan a FK:
   *   - attendance_records (required user_id) are deleted;
   *   - messages / call logs / audit logs / tickets they touched are detached
   *     (user_id → null) so the history itself survives, just un-attributed.
   * All in one transaction so a partial delete can never happen.
   */
  async remove(
    companyId: number,
    actorUserId: number,
    actorRole: string,
    targetId: number,
    reassignToUserId?: number | null,
  ) {
    const target = await this.requireMember(companyId, targetId);
    if (target.id === actorUserId) {
      throw new BadRequestException('You cannot delete yourself');
    }
    this.assertCanManage(actorRole, target.role);
    await this.gateway.disconnectUser(targetId);

    // Reassign/release conversations BEFORE deleting (this emits the socket
    // event and validates an active target while the member still exists).
    const { count } = await this.inbox.reassignConversations(
      companyId,
      targetId,
      reassignToUserId ?? null,
    );

    await this.prisma.$transaction([
      // Required FK → must be removed or the delete is rejected.
      this.prisma.attendanceRecord.deleteMany({ where: { user_id: targetId } }),
      // Nullable FKs → detach so the history rows survive un-attributed.
      this.prisma.message.updateMany({
        where: { user_id: targetId },
        data: { user_id: null },
      }),
      this.prisma.callLog.updateMany({
        where: { user_id: targetId },
        data: { user_id: null },
      }),
      this.prisma.auditLog.updateMany({
        where: { user_id: targetId },
        data: { user_id: null },
      }),
      this.prisma.supportTicket.updateMany({
        where: { assigned_user_id: targetId },
        data: { assigned_user_id: null },
      }),
      // Tables without a DB foreign key: clean up so nothing points at a ghost.
      // (Approved payroll lines / commission ledger keep their user_id as
      // history on purpose.)
      this.prisma.attendanceLeaveRequest.deleteMany({ where: { user_id: targetId } }),
      this.prisma.internalThreadMember.deleteMany({ where: { user_id: targetId } }),
      this.prisma.contentItem.updateMany({ where: { assignee_user_id: targetId }, data: { assignee_user_id: null } }),
      this.prisma.shipment.updateMany({ where: { packed_by_user_id: targetId }, data: { packed_by_user_id: null } }),
      this.prisma.user.delete({ where: { id: targetId } }),
    ]);

    return { id: targetId, deleted: true, reassignedChats: count };
  }

  /**
   * Bulk-reassign a member's chats WITHOUT changing their status — e.g. rebalance
   * an overloaded agent, or move a suspended member's chats after the fact.
   * `toUserId` null = release to the unassigned pool.
   */
  async reassignChats(
    companyId: number,
    actorRole: string,
    fromUserId: number,
    toUserId: number | null,
  ) {
    const from = await this.requireMember(companyId, fromUserId);
    this.assertCanManage(actorRole, from.role);
    return this.inbox.reassignConversations(companyId, fromUserId, toUserId);
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
    if (!company?.subscription) return; // no plan → don't block
    // Honor the super-admin per-company override (user_limit_override) — the
    // single source of truth is resolveEffectiveLimits, never an inline ternary.
    const { user_limit: limit } = resolveEffectiveLimits(
      company.subscription as any,
      company as any,
    );
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
