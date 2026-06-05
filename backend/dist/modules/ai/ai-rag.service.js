"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var AiRagService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiRagService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const cache_service_1 = require("../../common/services/cache.service");
const embedding_service_1 = require("./embedding.service");
const ai_metering_service_1 = require("./ai-metering.service");
const ai_constants_1 = require("./ai.constants");
const CHUNK_CACHE_TTL = 300;
function bufToFloat32(buf) {
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
function float32ToBuf(v) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function cosine(a, b) {
    const n = Math.min(a.length, b.length);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < n; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0)
        return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
let AiRagService = AiRagService_1 = class AiRagService {
    constructor(prisma, cache, embeddings, metering) {
        this.prisma = prisma;
        this.cache = cache;
        this.embeddings = embeddings;
        this.metering = metering;
        this.logger = new common_1.Logger(AiRagService_1.name);
    }
    isConfigured() {
        return this.embeddings.isConfigured();
    }
    cacheKey(companyId) {
        return `rag:${companyId}`;
    }
    async indexSource(companyId, sourceType, items) {
        if (!this.embeddings.isConfigured()) {
            return { embedded: false, indexed: 0 };
        }
        if (items.length === 0) {
            await this.prisma.aiKnowledgeChunk.deleteMany({
                where: { company_id: companyId, source_type: sourceType },
            });
            this.cache.del(this.cacheKey(companyId));
            return { embedded: true, indexed: 0 };
        }
        const vectors = await this.embeddings.embed(items.map((i) => i.content));
        if (!vectors)
            return { embedded: false, indexed: 0 };
        await this.prisma.aiKnowledgeChunk.deleteMany({
            where: { company_id: companyId, source_type: sourceType },
        });
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const vec = vectors[i];
            if (!vec)
                continue;
            await this.prisma.aiKnowledgeChunk.create({
                data: {
                    company_id: companyId,
                    source_type: sourceType,
                    source_id: it.sourceId.slice(0, 191),
                    title: it.title.slice(0, 255),
                    content: it.content,
                    embedding: float32ToBuf(vec),
                    dim: vec.length,
                },
            });
        }
        const chars = items.reduce((s, i) => s + i.content.length, 0);
        const tokens = Math.ceil(chars / ai_constants_1.CHARS_PER_TOKEN);
        await this.metering.recordEmbedding(companyId, tokens, tokens * ai_constants_1.EMBEDDING_MICROS_PER_TOKEN);
        this.cache.del(this.cacheKey(companyId));
        return { embedded: true, indexed: items.length };
    }
    async clear(companyId, sourceType) {
        await this.prisma.aiKnowledgeChunk.deleteMany({
            where: {
                company_id: companyId,
                ...(sourceType ? { source_type: sourceType } : {}),
            },
        });
        this.cache.del(this.cacheKey(companyId));
    }
    async loadChunks(companyId) {
        const cached = this.cache.get(this.cacheKey(companyId));
        if (cached)
            return cached;
        const rows = await this.prisma.aiKnowledgeChunk.findMany({
            where: { company_id: companyId },
            select: { title: true, content: true, embedding: true },
        });
        const loaded = rows.map((r) => ({
            title: r.title,
            content: r.content,
            vec: bufToFloat32(r.embedding),
        }));
        this.cache.set(this.cacheKey(companyId), loaded, CHUNK_CACHE_TTL);
        return loaded;
    }
    async retrieve(companyId, query, opts) {
        if (!this.embeddings.isConfigured())
            return null;
        const q = (query || '').trim();
        if (!q)
            return null;
        let chunks;
        try {
            chunks = await this.loadChunks(companyId);
        }
        catch (e) {
            this.logger.warn(`RAG load failed for company ${companyId}: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
        if (chunks.length === 0)
            return null;
        const qvec = await this.embeddings.embedOne(q);
        if (!qvec)
            return null;
        const topK = opts?.topK ?? ai_constants_1.RAG_TOP_K;
        const maxChars = opts?.maxChars ?? ai_constants_1.RAG_CHAR_BUDGET;
        const scored = chunks
            .map((c) => ({ c, score: cosine(qvec, c.vec) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
        let out = '';
        for (const { c } of scored) {
            const block = `## ${c.title}\n${c.content}\n\n`;
            if (out.length + block.length > maxChars)
                break;
            out += block;
        }
        return out.trim() || null;
    }
};
exports.AiRagService = AiRagService;
exports.AiRagService = AiRagService = AiRagService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        cache_service_1.CacheService,
        embedding_service_1.EmbeddingService,
        ai_metering_service_1.AiMeteringService])
], AiRagService);
//# sourceMappingURL=ai-rag.service.js.map