import { AiKnowledgeService } from './ai-knowledge.service';
import { CreateKnowledgeDto, UpdateKnowledgeDto } from './dto/knowledge.dto';
export declare class AiKnowledgeController {
    private readonly knowledge;
    constructor(knowledge: AiKnowledgeService);
    list(user: {
        companyId: number;
    }): import(".prisma/client").Prisma.PrismaPromise<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        content: string;
        title: string;
        enabled: boolean;
    }[]>;
    create(user: {
        companyId: number;
    }, dto: CreateKnowledgeDto): import(".prisma/client").Prisma.Prisma__AiKnowledgeBaseClient<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        content: string;
        title: string;
        enabled: boolean;
    }, never, import("@prisma/client/runtime/library").DefaultArgs>;
    update(user: {
        companyId: number;
    }, id: number, dto: UpdateKnowledgeDto): Promise<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        content: string;
        title: string;
        enabled: boolean;
    }>;
    remove(user: {
        companyId: number;
    }, id: number): Promise<{
        ok: boolean;
    }>;
}
