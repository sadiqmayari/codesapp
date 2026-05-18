import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { MetaTemplateSyncService } from './meta-template-sync.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { ListTemplatesDto } from './dto/list-templates.dto';
export declare class TemplatesService {
    private readonly prisma;
    private readonly metering;
    private readonly metaSync;
    constructor(prisma: PrismaService, metering: UsageMeteringService, metaSync: MetaTemplateSyncService);
    list(companyId: number, dto: ListTemplatesDto): Prisma.PrismaPromise<{
        status: import(".prisma/client").$Enums.TemplateStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        meta_template_id: string | null;
        category: import(".prisma/client").$Enums.TemplateCategory;
        content: Prisma.JsonValue;
        rejection_reason: string | null;
        deleted_at: Date | null;
    }[]>;
    get(companyId: number, id: number): Promise<{
        status: import(".prisma/client").$Enums.TemplateStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        meta_template_id: string | null;
        category: import(".prisma/client").$Enums.TemplateCategory;
        content: Prisma.JsonValue;
        rejection_reason: string | null;
        deleted_at: Date | null;
    }>;
    create(companyId: number, dto: CreateTemplateDto): Promise<{
        status: import(".prisma/client").$Enums.TemplateStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        meta_template_id: string | null;
        category: import(".prisma/client").$Enums.TemplateCategory;
        content: Prisma.JsonValue;
        rejection_reason: string | null;
        deleted_at: Date | null;
    }>;
    softDelete(companyId: number, id: number): Promise<{
        ok: boolean;
    }>;
    sync(companyId: number): Promise<{
        synced: number;
        deleted: number;
    }>;
}
