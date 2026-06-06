import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/services/cache.service';
import { EmbeddingService } from './embedding.service';
import { AiMeteringService } from './ai-metering.service';
export interface RagItem {
    sourceId: string;
    title: string;
    content: string;
}
export declare class AiRagService {
    private readonly prisma;
    private readonly cache;
    private readonly embeddings;
    private readonly metering;
    private readonly logger;
    constructor(prisma: PrismaService, cache: CacheService, embeddings: EmbeddingService, metering: AiMeteringService);
    isConfigured(): boolean;
    status(companyId: number): Promise<{
        configured: boolean;
        products: number;
        policies: number;
        total: number;
        lastSyncedAt: string | null;
    }>;
    private cacheKey;
    indexSource(companyId: number, sourceType: string, items: RagItem[]): Promise<{
        embedded: boolean;
        indexed: number;
    }>;
    clear(companyId: number, sourceType?: string): Promise<void>;
    private loadChunks;
    retrieve(companyId: number, query: string, opts?: {
        topK?: number;
        maxChars?: number;
    }): Promise<string | null>;
}
