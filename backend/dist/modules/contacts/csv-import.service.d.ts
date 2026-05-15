import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { CacheService } from '../../common/services/cache.service';
export interface CsvImportSummary {
    created: number;
    skipped: number;
    invalid: number;
    capped: boolean;
}
export declare class CsvImportService {
    private readonly prisma;
    private readonly metering;
    private readonly cache;
    private readonly logger;
    constructor(prisma: PrismaService, metering: UsageMeteringService, cache: CacheService);
    import(companyId: number, fileBuffer: Buffer): Promise<CsvImportSummary>;
    private getSubscription;
}
