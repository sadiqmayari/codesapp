import { TeamService } from './team.service';
import { CreateTeamMemberDto } from './dto/create-team-member.dto';
import { UpdateTeamMemberDto } from './dto/update-team-member.dto';
type Actor = {
    userId: number;
    companyId: number;
    role: string;
};
export declare class TeamController {
    private readonly teamService;
    constructor(teamService: TeamService);
    list(user: Actor): import(".prisma/client").Prisma.PrismaPromise<{
        status: import(".prisma/client").$Enums.UserStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string;
        role: import(".prisma/client").$Enums.UserRole;
    }[]>;
    create(user: Actor, dto: CreateTeamMemberDto): Promise<{
        status: import(".prisma/client").$Enums.UserStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string;
        role: import(".prisma/client").$Enums.UserRole;
    }>;
    update(user: Actor, id: number, dto: UpdateTeamMemberDto): Promise<{
        status: import(".prisma/client").$Enums.UserStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string;
        role: import(".prisma/client").$Enums.UserRole;
    }>;
    suspend(user: Actor, id: number): Promise<{
        status: import(".prisma/client").$Enums.UserStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string;
        role: import(".prisma/client").$Enums.UserRole;
    }>;
}
export {};
