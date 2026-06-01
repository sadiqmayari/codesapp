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
        title: string;
        body: string;
    }[]>;
    get(companyId: number, id: number): Promise<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        title: string;
        body: string;
    }>;
    create(companyId: number, dto: CreateCannedReplyDto): import(".prisma/client").Prisma.Prisma__CannedReplyClient<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        title: string;
        body: string;
    }, never, import("@prisma/client/runtime/library").DefaultArgs>;
    update(companyId: number, id: number, dto: UpdateCannedReplyDto): Promise<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        title: string;
        body: string;
    }>;
    remove(companyId: number, id: number): Promise<{
        ok: boolean;
    }>;
}
