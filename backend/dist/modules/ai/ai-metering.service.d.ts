import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import { AiFeature, AiProviderName, ModelTier } from './ai.constants';
import { NormalizedUsage } from './providers/llm-provider.interface';
export interface AiCostEstimates {
    provider: AiProviderName;
    standardPer1kRepliesUsd: number;
    highAccuracyPer1kRepliesUsd: number;
    visionPer100PhotosUsd: number;
    voicePerMinuteUsd: number;
}
export interface AiMonthlyUsage {
    period: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    billedCents: number;
    capCents: number;
    multiplier: number;
}
export declare class AiMeteringService {
    private readonly prisma;
    private readonly platformSetting;
    private readonly logger;
    constructor(prisma: PrismaService, platformSetting: PlatformSettingService);
    private currentPeriod;
    computeCostMicros(provider: AiProviderName, tier: ModelTier, usage: NormalizedUsage): number;
    private getMultiplier;
    private toBilledCents;
    private getCapCents;
    assertAllowed(companyId: number): Promise<void>;
    recordUsage(companyId: number, userId: number | null, feature: AiFeature, provider: AiProviderName, tier: ModelTier, usage: NormalizedUsage): Promise<void>;
    recordTranscription(companyId: number, costMicros: number): Promise<void>;
    recordEmbedding(companyId: number, tokens: number, costMicros: number): Promise<void>;
    getMonthlyUsage(companyId: number, capOverride?: number | null): Promise<AiMonthlyUsage>;
    private resolveCapForCompany;
    sumCostMicros(companyId: number, from: Date, to: Date): Promise<number>;
    billedCentsFor(costMicros: number): Promise<number>;
    getCostEstimates(): Promise<AiCostEstimates>;
}
