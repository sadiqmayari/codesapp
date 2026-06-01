import { TemplatesService } from './templates.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { ListTemplatesDto } from './dto/list-templates.dto';
export declare class TemplatesController {
    private readonly templatesService;
    constructor(templatesService: TemplatesService);
    list(user: {
        companyId: number;
    }, dto: ListTemplatesDto): import(".prisma/client").Prisma.PrismaPromise<{
        status: import(".prisma/client").$Enums.TemplateStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        content: import("@prisma/client/runtime/library").JsonValue;
        deleted_at: Date | null;
        meta_template_id: string | null;
        category: import(".prisma/client").$Enums.TemplateCategory;
        rejection_reason: string | null;
    }[]>;
    get(user: {
        companyId: number;
    }, id: number): Promise<{
        status: import(".prisma/client").$Enums.TemplateStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        content: import("@prisma/client/runtime/library").JsonValue;
        deleted_at: Date | null;
        meta_template_id: string | null;
        category: import(".prisma/client").$Enums.TemplateCategory;
        rejection_reason: string | null;
    }>;
    create(user: {
        companyId: number;
    }, dto: CreateTemplateDto): Promise<{
        status: import(".prisma/client").$Enums.TemplateStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        content: import("@prisma/client/runtime/library").JsonValue;
        deleted_at: Date | null;
        meta_template_id: string | null;
        category: import(".prisma/client").$Enums.TemplateCategory;
        rejection_reason: string | null;
    }>;
    remove(user: {
        companyId: number;
    }, id: number): Promise<{
        ok: boolean;
    }>;
    sync(user: {
        companyId: number;
    }): Promise<{
        synced: number;
        deleted: number;
    }>;
}
