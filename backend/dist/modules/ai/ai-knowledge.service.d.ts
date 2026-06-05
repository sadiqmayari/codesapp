import { PrismaService } from '../../prisma/prisma.service';
import { CreateKnowledgeDto, UpdateKnowledgeDto } from './dto/knowledge.dto';
export declare class AiKnowledgeService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    list(companyId: number): import(".prisma/client").Prisma.PrismaPromise<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        content: string;
        title: string;
        enabled: boolean;
    }[]>;
    get(companyId: number, id: number): Promise<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        content: string;
        title: string;
        enabled: boolean;
    }>;
    create(companyId: number, dto: CreateKnowledgeDto): import(".prisma/client").Prisma.Prisma__AiKnowledgeBaseClient<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        content: string;
        title: string;
        enabled: boolean;
    }, never, import("@prisma/client/runtime/library").DefaultArgs>;
    update(companyId: number, id: number, dto: UpdateKnowledgeDto): Promise<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        content: string;
        title: string;
        enabled: boolean;
    }>;
    remove(companyId: number, id: number): Promise<{
        ok: boolean;
    }>;
    upsertByTitle(companyId: number, title: string, content: string): Promise<{
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        content: string;
        title: string;
        enabled: boolean;
    }>;
    deleteByTitle(companyId: number, title: string): Promise<void>;
}
