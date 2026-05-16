import { SegmentsService } from './segments.service';
import { CreateSegmentDto, UpdateSegmentDto } from './dto/create-segment.dto';
export declare class SegmentsController {
    private readonly segmentsService;
    constructor(segmentsService: SegmentsService);
    list(user: {
        companyId: number;
    }): import(".prisma/client").Prisma.PrismaPromise<{
        filter: import("@prisma/client/runtime/library").JsonValue;
        id: number;
        company_id: number;
        name: string;
        created_at: Date;
        updated_at: Date;
    }[]>;
    create(user: {
        companyId: number;
    }, dto: CreateSegmentDto): import(".prisma/client").Prisma.Prisma__SegmentClient<{
        filter: import("@prisma/client/runtime/library").JsonValue;
        id: number;
        company_id: number;
        name: string;
        created_at: Date;
        updated_at: Date;
    }, never, import("@prisma/client/runtime/library").DefaultArgs>;
    update(user: {
        companyId: number;
    }, id: number, dto: UpdateSegmentDto): Promise<{
        filter: import("@prisma/client/runtime/library").JsonValue;
        id: number;
        company_id: number;
        name: string;
        created_at: Date;
        updated_at: Date;
    }>;
    remove(user: {
        companyId: number;
    }, id: number): Promise<{
        ok: boolean;
    }>;
    preview(user: {
        companyId: number;
    }, id: number, limit?: string): Promise<{
        id: number;
        email: string | null;
        name: string;
        phone: string;
        tags: import("@prisma/client/runtime/library").JsonValue;
    }[]>;
}
