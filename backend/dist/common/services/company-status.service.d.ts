import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from './cache.service';
export declare class CompanyStatusService {
    private readonly prisma;
    private readonly cache;
    private static readonly TTL_SECONDS;
    constructor(prisma: PrismaService, cache: CacheService);
    private key;
    isActive(companyId: number): Promise<boolean>;
    invalidate(companyId: number): void;
}
