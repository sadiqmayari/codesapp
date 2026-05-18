"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeamService = void 0;
const common_1 = require("@nestjs/common");
const bcrypt = require("bcryptjs");
const prisma_service_1 = require("../../prisma/prisma.service");
const BCRYPT_ROUNDS = 12;
const SELECT = {
    id: true,
    name: true,
    email: true,
    role: true,
    status: true,
    created_at: true,
};
let TeamService = class TeamService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    list(companyId) {
        return this.prisma.user.findMany({
            where: { company_id: companyId },
            select: SELECT,
            orderBy: { created_at: 'asc' },
        });
    }
    async create(companyId, actorRole, dto) {
        if (dto.role === 'admin' && actorRole !== 'owner') {
            throw new common_1.ForbiddenException('Only the owner can create admins');
        }
        const email = dto.email.trim().toLowerCase();
        const existing = await this.prisma.user.findUnique({ where: { email } });
        if (existing) {
            throw new common_1.ConflictException('A user with this email already exists');
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
    async update(companyId, actorUserId, actorRole, targetId, dto) {
        const target = await this.requireMember(companyId, targetId);
        if (target.id === actorUserId) {
            throw new common_1.BadRequestException('You cannot modify your own membership');
        }
        if (target.role === 'owner') {
            throw new common_1.ForbiddenException('The owner cannot be modified');
        }
        if (dto.role === 'admin' && actorRole !== 'owner') {
            throw new common_1.ForbiddenException('Only the owner can promote to admin');
        }
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
    async suspend(companyId, actorUserId, targetId) {
        const target = await this.requireMember(companyId, targetId);
        if (target.id === actorUserId) {
            throw new common_1.BadRequestException('You cannot remove yourself');
        }
        if (target.role === 'owner') {
            throw new common_1.ForbiddenException('The owner cannot be removed');
        }
        return this.prisma.user.update({
            where: { id: targetId },
            data: { status: 'suspended' },
            select: SELECT,
        });
    }
    async requireMember(companyId, id) {
        const user = await this.prisma.user.findFirst({
            where: { id, company_id: companyId },
        });
        if (!user)
            throw new common_1.NotFoundException('Team member not found');
        return user;
    }
    async assertUnderUserLimit(companyId) {
        const company = await this.prisma.company.findUnique({
            where: { id: companyId },
            include: { subscription: true },
        });
        const limit = company?.subscription?.user_limit ?? 0;
        if (limit <= 0)
            return;
        const active = await this.prisma.user.count({
            where: { company_id: companyId, status: { not: 'suspended' } },
        });
        if (active >= limit) {
            throw new common_1.ForbiddenException(`Plan user limit reached (${active}/${limit}). Upgrade your plan or suspend a member.`);
        }
    }
};
exports.TeamService = TeamService;
exports.TeamService = TeamService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], TeamService);
//# sourceMappingURL=team.service.js.map