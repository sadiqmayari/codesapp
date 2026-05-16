import { BroadcastsService } from './broadcasts.service';
import { CreateBroadcastDto } from './dto/create-broadcast.dto';
import { ScheduleBroadcastDto } from './dto/schedule-broadcast.dto';
import { ListBroadcastsDto } from './dto/list-broadcasts.dto';
export declare class BroadcastsController {
    private readonly broadcastsService;
    constructor(broadcastsService: BroadcastsService);
    list(user: {
        companyId: number;
    }, dto: ListBroadcastsDto): import(".prisma/client").Prisma.PrismaPromise<{
        id: number;
        company_id: number;
        name: string;
        status: import(".prisma/client").$Enums.BroadcastStatus;
        created_at: Date;
        template_id: number;
        audience_filter: import("@prisma/client/runtime/library").JsonValue;
        scheduled_at: Date | null;
        sent_count: number;
        delivered_count: number;
        read_count: number;
        failed_count: number;
    }[]>;
    get(user: {
        companyId: number;
    }, id: number): Promise<{
        id: number;
        company_id: number;
        name: string;
        status: import(".prisma/client").$Enums.BroadcastStatus;
        created_at: Date;
        template_id: number;
        audience_filter: import("@prisma/client/runtime/library").JsonValue;
        scheduled_at: Date | null;
        sent_count: number;
        delivered_count: number;
        read_count: number;
        failed_count: number;
    }>;
    create(user: {
        companyId: number;
    }, dto: CreateBroadcastDto): Promise<{
        id: number;
        company_id: number;
        name: string;
        status: import(".prisma/client").$Enums.BroadcastStatus;
        created_at: Date;
        template_id: number;
        audience_filter: import("@prisma/client/runtime/library").JsonValue;
        scheduled_at: Date | null;
        sent_count: number;
        delivered_count: number;
        read_count: number;
        failed_count: number;
    }>;
    update(user: {
        companyId: number;
    }, id: number, dto: CreateBroadcastDto): Promise<{
        id: number;
        company_id: number;
        name: string;
        status: import(".prisma/client").$Enums.BroadcastStatus;
        created_at: Date;
        template_id: number;
        audience_filter: import("@prisma/client/runtime/library").JsonValue;
        scheduled_at: Date | null;
        sent_count: number;
        delivered_count: number;
        read_count: number;
        failed_count: number;
    }>;
    send(user: {
        companyId: number;
    }, id: number): Promise<{
        ok: boolean;
    }>;
    schedule(user: {
        companyId: number;
    }, id: number, dto: ScheduleBroadcastDto): Promise<{
        ok: boolean;
        runAt: Date;
    }>;
    cancel(user: {
        companyId: number;
    }, id: number): Promise<{
        ok: boolean;
    }>;
    analytics(user: {
        companyId: number;
    }, id: number): Promise<{
        id: number;
        name: string;
        status: import(".prisma/client").$Enums.BroadcastStatus;
        total: number;
        sent: number;
        delivered: number;
        read: number;
        failed: number;
        scheduledAt: Date | null;
        createdAt: Date;
    }>;
}
