import { PrismaService } from '../../prisma/prisma.service';
import { CreateCannedReplyDto } from './dto/create-canned-reply.dto';
import { UpdateCannedReplyDto } from './dto/update-canned-reply.dto';
export declare class CannedRepliesService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    list(companyId: number): import(".prisma/client").Prisma.PrismaPromise<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        body: string;
        title: string;
    }[]>;
    get(companyId: number, id: number): Promise<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        body: string;
        title: string;
    }>;
    create(companyId: number, dto: CreateCannedReplyDto): import(".prisma/client").Prisma.Prisma__CannedReplyClient<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        body: string;
        title: string;
    }, never, import("@prisma/client/runtime/library").DefaultArgs>;
    update(companyId: number, id: number, dto: UpdateCannedReplyDto): Promise<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        body: string;
        title: string;
    }>;
    remove(companyId: number, id: number): Promise<{
        ok: boolean;
    }>;
}
