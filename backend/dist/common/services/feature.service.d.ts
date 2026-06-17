import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingService } from './platform-setting.service';
import { FeatureOverride, PlatformFeature } from '../features/feature.constants';
import { EngagementMode } from '../../modules/ai/ai.constants';
export declare class FeatureService {
    private readonly prisma;
    private readonly platformSetting;
    constructor(prisma: PrismaService, platformSetting: PlatformSettingService);
    getOverride(companyId: number, feature: PlatformFeature): Promise<FeatureOverride | null>;
    proactiveNotificationsEnabled(companyId: number): Promise<boolean>;
    engagementModeFor(companyId: number): Promise<'off' | EngagementMode>;
}
