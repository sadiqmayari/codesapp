import { CannedRepliesService } from './canned-replies.service';
import { CreateCannedReplyDto } from './dto/create-canned-reply.dto';
import { UpdateCannedReplyDto } from './dto/update-canned-reply.dto';
export declare class CannedRepliesController {
    private readonly cannedReplies;
    constructor(cannedReplies: CannedRepliesService);
    list(user: {
        companyId: number;
    }): import(".prisma/client").Prisma.PrismaPromise<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        title: string;
        body: string;
    }[]>;
    create(user: {
        companyId: number;
    }, dto: CreateCannedReplyDto): import(".prisma/client").Prisma.Prisma__CannedReplyClient<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        title: string;
        body: string;
    }, never, import("@prisma/client/runtime/library").DefaultArgs>;
    update(user: {
        companyId: number;
    }, id: number, dto: UpdateCannedReplyDto): Promise<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        title: string;
        body: string;
    }>;
    remove(user: {
        companyId: number;
    }, id: number): Promise<{
        ok: boolean;
    }>;
}
