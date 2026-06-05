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
var EmbeddingService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmbeddingService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const openai_1 = require("openai");
const ai_constants_1 = require("./ai.constants");
let EmbeddingService = EmbeddingService_1 = class EmbeddingService {
    constructor(config) {
        this.config = config;
        this.logger = new common_1.Logger(EmbeddingService_1.name);
        this.client = null;
    }
    isConfigured() {
        return !!this.config.get('OPENAI_API_KEY');
    }
    getClient() {
        if (this.client)
            return this.client;
        const apiKey = this.config.get('OPENAI_API_KEY');
        if (!apiKey)
            return null;
        this.client = new openai_1.default({ apiKey });
        return this.client;
    }
    async embed(texts) {
        const client = this.getClient();
        if (!client)
            return null;
        if (texts.length === 0)
            return [];
        const out = [];
        const BATCH = 96;
        try {
            for (let i = 0; i < texts.length; i += BATCH) {
                const slice = texts
                    .slice(i, i + BATCH)
                    .map((t) => (t && t.trim() ? t.slice(0, 8000) : ' '));
                const res = await client.embeddings.create({
                    model: ai_constants_1.EMBEDDING_MODEL,
                    input: slice,
                });
                for (const d of res.data)
                    out.push(Float32Array.from(d.embedding));
            }
            return out;
        }
        catch (e) {
            this.logger.warn(`Embedding failed: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }
    async embedOne(text) {
        const res = await this.embed([text]);
        return res && res[0] ? res[0] : null;
    }
};
exports.EmbeddingService = EmbeddingService;
exports.EmbeddingService = EmbeddingService = EmbeddingService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], EmbeddingService);
//# sourceMappingURL=embedding.service.js.map