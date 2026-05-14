import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../services/cache.service';
export declare class PlanGuard implements CanActivate {
    private readonly reflector;
    private readonly prisma;
    private readonly cache;
    constructor(reflector: Reflector, prisma: PrismaService, cache: CacheService);
    canActivate(context: ExecutionContext): Promise<boolean>;
    private getSubscription;
    private getCurrentUsage;
    private getLimit;
}
