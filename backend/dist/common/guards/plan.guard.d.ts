import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../services/cache.service';
import { PlatformSettingService } from '../services/platform-setting.service';
export declare class PlanGuard implements CanActivate {
    private readonly reflector;
    private readonly prisma;
    private readonly cache;
    private readonly platformSetting;
    constructor(reflector: Reflector, prisma: PrismaService, cache: CacheService, platformSetting: PlatformSettingService);
    canActivate(context: ExecutionContext): Promise<boolean>;
    private resolveAction;
    private getSubscription;
    private getCurrentUsage;
    private getLimit;
}
