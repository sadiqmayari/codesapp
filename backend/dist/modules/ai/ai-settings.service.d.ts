import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { UpdateAiSettingsDto } from './dto/ai-settings.dto';
export interface AiSettingsView {
    aiEnabled: boolean;
    autoReplyEnabled: boolean;
    autoOrderEnabled: boolean;
    brandTone: string | null;
    defaultLanguage: string | null;
    monthlyCapCents: number | null;
    planAiEnabled: boolean;
}
export declare class AiSettingsService {
    private readonly prisma;
    private readonly cache;
    constructor(prisma: PrismaService, cache: CacheService);
    get(companyId: number): Promise<AiSettingsView>;
    update(companyId: number, dto: UpdateAiSettingsDto): Promise<AiSettingsView>;
}
