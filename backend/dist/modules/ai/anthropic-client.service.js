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
var AnthropicClientService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnthropicClientService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const sdk_1 = require("@anthropic-ai/sdk");
const ai_constants_1 = require("./ai.constants");
let AnthropicClientService = AnthropicClientService_1 = class AnthropicClientService {
    constructor(config) {
        this.config = config;
        this.logger = new common_1.Logger(AnthropicClientService_1.name);
        this.client = null;
    }
    isConfigured() {
        return !!this.config.get('ANTHROPIC_API_KEY');
    }
    getClient() {
        if (this.client)
            return this.client;
        const apiKey = this.config.get('ANTHROPIC_API_KEY');
        if (!apiKey) {
            throw new common_1.ServiceUnavailableException('AI is not configured on this server.');
        }
        this.client = new sdk_1.default({ apiKey });
        return this.client;
    }
    async complete(opts) {
        const model = ai_constants_1.MODELS[opts.tier];
        const client = this.getClient();
        const system = opts.system.map((b) => ({
            type: 'text',
            text: b.text,
            ...(b.cache ? { cache_control: { type: 'ephemeral' } } : {}),
        }));
        const res = await client.messages.create({
            model: model.id,
            max_tokens: opts.maxTokens,
            temperature: opts.temperature ?? 0.4,
            system,
            messages: opts.messages,
        });
        const text = res.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
        const u = res.usage;
        const usage = {
            inputTokens: u?.input_tokens ?? 0,
            outputTokens: u?.output_tokens ?? 0,
            cacheReadTokens: u?.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
        };
        return { text, usage, modelId: model.id };
    }
};
exports.AnthropicClientService = AnthropicClientService;
exports.AnthropicClientService = AnthropicClientService = AnthropicClientService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], AnthropicClientService);
//# sourceMappingURL=anthropic-client.service.js.map