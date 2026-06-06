import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { AiCostEstimates, AiMeteringService } from './ai-metering.service';
import { UpdateAiSettingsDto } from './dto/ai-settings.dto';
export interface AiSettingsView {
    aiEnabled: boolean;
    autoReplyEnabled: boolean;
    autoOrderEnabled: boolean;
    autoOrderAllEnabled: boolean;
    brandTone: string | null;
    defaultLanguage: string | null;
    monthlyCapCents: number | null;
    aiTier: 'fast' | 'smart' | null;
    visionEnabled: boolean;
    voiceEnabled: boolean;
    premiumLocked: boolean;
    planAiEnabled: boolean;
    estimates: AiCostEstimates;
}
export declare class AiSettingsService {
    private readonly prisma;
    private readonly cache;
    private readonly metering;
    constructor(prisma: PrismaService, cache: CacheService, metering: AiMeteringService);
    get(companyId: number): Promise<AiSettingsView>;
    update(companyId: number, dto: UpdateAiSettingsDto): Promise<AiSettingsView>;
    private isPremiumLocked;
}
