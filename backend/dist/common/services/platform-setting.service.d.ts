import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from './cache.service';
import { EngagementMode, ModelTier } from '../../modules/ai/ai.constants';
export type UsageLimitAction = 'block' | 'warn_only';
export declare class PlatformSettingService {
    private readonly prisma;
    private readonly cache;
    constructor(prisma: PrismaService, cache: CacheService);
    private cacheKey;
    get(key: string, fallback: string): Promise<string>;
    set(key: string, value: string): Promise<void>;
    getUsageLimitAction(): Promise<UsageLimitAction>;
    setUsageLimitAction(action: UsageLimitAction): Promise<void>;
    getAutonomousTier(): Promise<ModelTier>;
    setAutonomousTier(tier: ModelTier): Promise<void>;
    isAiAgentEnabled(companyId: number): Promise<boolean>;
    isEngagementEngineEnabled(companyId: number): Promise<boolean>;
    getEngagementMode(): Promise<EngagementMode>;
}
