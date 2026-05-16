import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { CreateBotDto } from './dto/create-bot.dto';
import { UpdateBotDto } from './dto/update-bot.dto';
export declare class BotsService {
    private readonly prisma;
    private readonly cache;
    constructor(prisma: PrismaService, cache: CacheService);
    list(companyId: number): import(".prisma/client").Prisma.PrismaPromise<{
        status: import(".prisma/client").$Enums.BotStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        keyword: string;
        actions: import("@prisma/client/runtime/library").JsonValue;
        trigger_type: import(".prisma/client").$Enums.BotTriggerType;
    }[]>;
    get(companyId: number, id: number): Promise<{
        status: import(".prisma/client").$Enums.BotStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        keyword: string;
        actions: import("@prisma/client/runtime/library").JsonValue;
        trigger_type: import(".prisma/client").$Enums.BotTriggerType;
    }>;
    create(companyId: number, dto: CreateBotDto): Promise<{
        status: import(".prisma/client").$Enums.BotStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        keyword: string;
        actions: import("@prisma/client/runtime/library").JsonValue;
        trigger_type: import(".prisma/client").$Enums.BotTriggerType;
    }>;
    update(companyId: number, id: number, dto: UpdateBotDto): Promise<{
        status: import(".prisma/client").$Enums.BotStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        keyword: string;
        actions: import("@prisma/client/runtime/library").JsonValue;
        trigger_type: import(".prisma/client").$Enums.BotTriggerType;
    }>;
    delete(companyId: number, id: number): Promise<{
        ok: boolean;
    }>;
    toggle(companyId: number, id: number): Promise<{
        status: import(".prisma/client").$Enums.BotStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number;
        keyword: string;
        actions: import("@prisma/client/runtime/library").JsonValue;
        trigger_type: import(".prisma/client").$Enums.BotTriggerType;
    }>;
    private invalidateCache;
}
