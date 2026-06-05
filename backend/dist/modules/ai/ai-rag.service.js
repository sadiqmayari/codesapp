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
function sanitizeText(s) {
    return s
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
        .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
        .trim();
}
function base64ToFloat32(s) {
    const buf = Buffer.from(s, 'base64');
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
function float32ToBase64(v) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
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
            await this.prisma.$executeRaw `
        DELETE FROM ai_knowledge_chunks
        WHERE company_id = ${companyId} AND source_type = ${sourceType}`;
            this.cache.del(this.cacheKey(companyId));
            return { embedded: true, indexed: 0 };
        }
        const clean = items.map((it) => ({
            sourceId: sanitizeText(it.sourceId.slice(0, 191)),
            title: sanitizeText(it.title.slice(0, 255)),
            content: sanitizeText(it.content),
        }));
        const vectors = await this.embeddings.embed(clean.map((i) => i.content));
        if (!vectors)
            return { embedded: false, indexed: 0 };
        await this.prisma.$executeRaw `
      DELETE FROM ai_knowledge_chunks
      WHERE company_id = ${companyId} AND source_type = ${sourceType}`;
        let inserted = 0;
        let skipped = 0;
        for (let i = 0; i < clean.length; i++) {
            const it = clean[i];
            const vec = vectors[i];
            if (!vec)
                continue;
            try {
                await this.prisma.$executeRaw `
          INSERT INTO ai_knowledge_chunks
            (company_id, source_type, source_id, title, content, embedding, dim, created_at, updated_at)
          VALUES (
            ${companyId},
            ${sourceType},
            ${it.sourceId},
            ${it.title},
            ${it.content},
            ${float32ToBase64(vec)},
            ${vec.length},
            NOW(3),
            NOW(3)
          )`;
                inserted++;
            }
            catch (e) {
                skipped++;
                this.logger.warn(`Skipped chunk ${sourceType}/${it.sourceId} for company ${companyId}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        if (skipped > 0) {
            this.logger.warn(`indexSource(${sourceType}) company ${companyId}: inserted ${inserted}, skipped ${skipped}`);
        }
        const chars = clean.reduce((s, i) => s + i.content.length, 0);
        const tokens = Math.ceil(chars / ai_constants_1.CHARS_PER_TOKEN);
        await this.metering.recordEmbedding(companyId, tokens, tokens * ai_constants_1.EMBEDDING_MICROS_PER_TOKEN);
        this.cache.del(this.cacheKey(companyId));
        return { embedded: true, indexed: inserted };
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
        const rows = await this.prisma.$queryRaw `SELECT title, content, embedding, dim
        FROM ai_knowledge_chunks
        WHERE company_id = ${companyId}`;
        const loaded = [];
        for (const r of rows) {
            let vec;
            try {
                vec = base64ToFloat32(r.embedding);
            }
            catch {
                continue;
            }
            if (vec.length === 0 || (r.dim > 0 && vec.length !== r.dim))
                continue;
            loaded.push({ title: r.title, content: r.content, vec });
        }
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