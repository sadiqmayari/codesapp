import { BotsService } from './bots.service';
import { CreateBotDto } from './dto/create-bot.dto';
import { UpdateBotDto } from './dto/update-bot.dto';
export declare class BotsController {
    private readonly botsService;
    constructor(botsService: BotsService);
    list(user: {
        companyId: number;
    }): import(".prisma/client").Prisma.PrismaPromise<{
        id: number;
        company_id: number;
        name: string;
        status: import(".prisma/client").$Enums.BotStatus;
        created_at: Date;
        keyword: string;
        actions: import("@prisma/client/runtime/library").JsonValue;
        trigger_type: import(".prisma/client").$Enums.BotTriggerType;
    }[]>;
    get(user: {
        companyId: number;
    }, id: number): Promise<{
        id: number;
        company_id: number;
        name: string;
        status: import(".prisma/client").$Enums.BotStatus;
        created_at: Date;
        keyword: string;
        actions: import("@prisma/client/runtime/library").JsonValue;
        trigger_type: import(".prisma/client").$Enums.BotTriggerType;
    }>;
    create(user: {
        companyId: number;
    }, dto: CreateBotDto): Promise<{
        id: number;
        company_id: number;
        name: string;
        status: import(".prisma/client").$Enums.BotStatus;
        created_at: Date;
        keyword: string;
        actions: import("@prisma/client/runtime/library").JsonValue;
        trigger_type: import(".prisma/client").$Enums.BotTriggerType;
    }>;
    update(user: {
        companyId: number;
    }, id: number, dto: UpdateBotDto): Promise<{
        id: number;
        company_id: number;
        name: string;
        status: import(".prisma/client").$Enums.BotStatus;
        created_at: Date;
        keyword: string;
        actions: import("@prisma/client/runtime/library").JsonValue;
        trigger_type: import(".prisma/client").$Enums.BotTriggerType;
    }>;
    remove(user: {
        companyId: number;
    }, id: number): Promise<{
        ok: boolean;
    }>;
    toggle(user: {
        companyId: number;
    }, id: number): Promise<{
        id: number;
        company_id: number;
        name: string;
        status: import(".prisma/client").$Enums.BotStatus;
        created_at: Date;
        keyword: string;
        actions: import("@prisma/client/runtime/library").JsonValue;
        trigger_type: import(".prisma/client").$Enums.BotTriggerType;
    }>;
}
