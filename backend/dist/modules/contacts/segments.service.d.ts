import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateSegmentDto, SegmentFilterDto, UpdateSegmentDto } from './dto/create-segment.dto';
export declare class SegmentsService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    list(companyId: number): Prisma.PrismaPromise<{
        filter: Prisma.JsonValue;
        id: number;
        company_id: number;
        name: string;
        created_at: Date;
        updated_at: Date;
    }[]>;
    get(companyId: number, id: number): Promise<{
        filter: Prisma.JsonValue;
        id: number;
        company_id: number;
        name: string;
        created_at: Date;
        updated_at: Date;
    }>;
    create(companyId: number, dto: CreateSegmentDto): Prisma.Prisma__SegmentClient<{
        filter: Prisma.JsonValue;
        id: number;
        company_id: number;
        name: string;
        created_at: Date;
        updated_at: Date;
    }, never, import("@prisma/client/runtime/library").DefaultArgs>;
    update(companyId: number, id: number, dto: UpdateSegmentDto): Promise<{
        filter: Prisma.JsonValue;
        id: number;
        company_id: number;
        name: string;
        created_at: Date;
        updated_at: Date;
    }>;
    delete(companyId: number, id: number): Promise<{
        ok: boolean;
    }>;
    static buildContactWhere(companyId: number, filter: SegmentFilterDto): Prisma.ContactWhereInput;
    resolveContacts(companyId: number, filter: SegmentFilterDto, limit?: number): Promise<number[]>;
    preview(companyId: number, id: number, limit?: number): Promise<{
        id: number;
        email: string | null;
        name: string;
        phone: string;
        tags: Prisma.JsonValue;
    }[]>;
}
