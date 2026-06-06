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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAiProvider = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const openai_1 = require("openai");
const ai_constants_1 = require("../ai.constants");
let OpenAiProvider = class OpenAiProvider {
    constructor(config) {
        this.config = config;
        this.name = 'openai';
        this.client = null;
    }
    isConfigured() {
        return !!this.config.get('OPENAI_API_KEY');
    }
    getClient() {
        if (this.client)
            return this.client;
        const apiKey = this.config.get('OPENAI_API_KEY');
        if (!apiKey) {
            throw new common_1.ServiceUnavailableException('OpenAI is not configured on this server.');
        }
        this.client = new openai_1.default({ apiKey });
        return this.client;
    }
    async complete(opts) {
        const model = ai_constants_1.PROVIDER_MODELS.openai[opts.tier];
        const client = this.getClient();
        const systemText = opts.system.map((b) => b.text).join('\n\n');
        const userContent = opts.images && opts.images.length
            ? [
                { type: 'text', text: opts.userText },
                ...opts.images.map((img) => ({
                    type: 'image_url',
                    image_url: {
                        url: `data:${img.mime};base64,${img.dataBase64}`,
                    },
                })),
            ]
            : opts.userText;
        const res = await client.chat.completions.create({
            model: model.id,
            max_tokens: opts.maxTokens,
            temperature: opts.temperature ?? 0.4,
            messages: [
                { role: 'system', content: systemText },
                { role: 'user', content: userContent },
            ],
        });
        const text = (res.choices[0]?.message?.content ?? '').trim();
        const u = res.usage;
        const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
        const usage = {
            inputTokens: Math.max((u?.prompt_tokens ?? 0) - cached, 0),
            outputTokens: u?.completion_tokens ?? 0,
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
        };
        return { text, usage, modelId: model.id };
    }
    async completeWithTools(opts) {
        const model = ai_constants_1.PROVIDER_MODELS.openai[opts.tier];
        const client = this.getClient();
        const systemText = opts.system.map((b) => b.text).join('\n\n');
        const messages = [
            { role: 'system', content: systemText },
        ];
        for (const m of opts.messages) {
            if (m.role === 'user') {
                messages.push({ role: 'user', content: m.text });
            }
            else if (m.role === 'assistant') {
                const msg = {
                    role: 'assistant',
                    content: m.text ?? '',
                };
                if (m.toolCalls?.length) {
                    msg.tool_calls = m.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
                    }));
                }
                messages.push(msg);
            }
            else {
                messages.push({
                    role: 'tool',
                    tool_call_id: m.toolCallId,
                    content: m.content,
                });
            }
        }
        const tools = opts.tools.map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
            },
        }));
        const res = await client.chat.completions.create({
            model: model.id,
            max_tokens: opts.maxTokens,
            temperature: opts.temperature ?? 0.4,
            messages,
            ...(tools.length ? { tools } : {}),
        });
        const choice = res.choices[0]?.message;
        const text = (choice?.content ?? '').trim() || null;
        const toolCalls = [];
        for (const tc of choice?.tool_calls ?? []) {
            if (tc.type !== 'function')
                continue;
            let input = {};
            try {
                input = tc.function.arguments
                    ? JSON.parse(tc.function.arguments)
                    : {};
            }
            catch {
                input = {};
            }
            toolCalls.push({ id: tc.id, name: tc.function.name, input });
        }
        const u = res.usage;
        const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
        const usage = {
            inputTokens: Math.max((u?.prompt_tokens ?? 0) - cached, 0),
            outputTokens: u?.completion_tokens ?? 0,
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
        };
        return {
            text,
            toolCalls,
            usage,
            modelId: model.id,
            stop: res.choices[0]?.finish_reason === 'tool_calls' ? 'tool_use' : 'end',
        };
    }
};
exports.OpenAiProvider = OpenAiProvider;
exports.OpenAiProvider = OpenAiProvider = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], OpenAiProvider);
//# sourceMappingURL=openai.provider.js.map