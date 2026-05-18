import { PrismaService } from '../../prisma/prisma.service';
import { CreateTeamMemberDto } from './dto/create-team-member.dto';
import { UpdateTeamMemberDto } from './dto/update-team-member.dto';
export declare class TeamService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    list(companyId: number): import(".prisma/client").Prisma.PrismaPromise<{
        status: import(".prisma/client").$Enums.UserStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string;
        role: import(".prisma/client").$Enums.UserRole;
    }[]>;
    create(companyId: number, actorRole: string, dto: CreateTeamMemberDto): Promise<{
        status: import(".prisma/client").$Enums.UserStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string;
        role: import(".prisma/client").$Enums.UserRole;
    }>;
    update(companyId: number, actorUserId: number, actorRole: string, targetId: number, dto: UpdateTeamMemberDto): Promise<{
        status: import(".prisma/client").$Enums.UserStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string;
        role: import(".prisma/client").$Enums.UserRole;
    }>;
    suspend(companyId: number, actorUserId: number, targetId: number): Promise<{
        status: import(".prisma/client").$Enums.UserStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string;
        role: import(".prisma/client").$Enums.UserRole;
    }>;
    private requireMember;
    private assertUnderUserLimit;
}
