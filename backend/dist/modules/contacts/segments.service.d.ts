import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateSegmentDto, SegmentFilterDto, UpdateSegmentDto } from './dto/create-segment.dto';
export declare class SegmentsService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    list(companyId: number): Prisma.PrismaPromise<{
        filter: Prisma.JsonValue;
        created_at: Date;
        id: number;
        name: string;
        updated_at: Date;
        company_id: number;
    }[]>;
    get(companyId: number, id: number): Promise<{
        filter: Prisma.JsonValue;
        created_at: Date;
        id: number;
        name: string;
        updated_at: Date;
        company_id: number;
    }>;
    create(companyId: number, dto: CreateSegmentDto): Prisma.Prisma__SegmentClient<{
        filter: Prisma.JsonValue;
        created_at: Date;
        id: number;
        name: string;
        updated_at: Date;
        company_id: number;
    }, never, import("@prisma/client/runtime/library").DefaultArgs>;
    update(companyId: number, id: number, dto: UpdateSegmentDto): Promise<{
        filter: Prisma.JsonValue;
        created_at: Date;
        id: number;
        name: string;
        updated_at: Date;
        company_id: number;
    }>;
    delete(companyId: number, id: number): Promise<{
        ok: boolean;
    }>;
    static buildContactWhere(companyId: number, filter: SegmentFilterDto): Prisma.ContactWhereInput;
    resolveContacts(companyId: number, filter: SegmentFilterDto, limit?: number): Promise<number[]>;
    preview(companyId: number, id: number, limit?: number): Promise<{
        id: number;
        name: string;
        email: string | null;
        phone: string;
        tags: Prisma.JsonValue;
    }[]>;
}
