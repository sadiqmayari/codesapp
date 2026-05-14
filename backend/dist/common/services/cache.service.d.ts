import { OnModuleDestroy } from '@nestjs/common';
export declare class CacheService implements OnModuleDestroy {
    private readonly cache;
    constructor();
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T, ttlSeconds: number): void;
    del(key: string): void;
    subscriptionKey(companyId: number): string;
    analyticsKey(companyId: number, hash: string): string;
    onModuleDestroy(): void;
}
