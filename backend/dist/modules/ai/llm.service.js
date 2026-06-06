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
exports.LlmService = void 0;
const common_1 = require("@nestjs/common");
const platform_setting_service_1 = require("../../common/services/platform-setting.service");
const ai_constants_1 = require("./ai.constants");
const anthropic_provider_1 = require("./providers/anthropic.provider");
const openai_provider_1 = require("./providers/openai.provider");
let LlmService = class LlmService {
    constructor(platformSetting, anthropic, openai) {
        this.platformSetting = platformSetting;
        this.providers = { anthropic, openai };
    }
    async getActiveProviderName() {
        const v = await this.platformSetting.get(ai_constants_1.AI_PROVIDER_KEY, ai_constants_1.AI_PROVIDER_DEFAULT);
        return v === 'openai' ? 'openai' : 'anthropic';
    }
    async isConfigured() {
        const name = await this.getActiveProviderName();
        return this.providers[name].isConfigured();
    }
    async complete(opts) {
        const name = await this.getActiveProviderName();
        const result = await this.providers[name].complete(opts);
        return { ...result, provider: name };
    }
    async completeWithTools(opts) {
        const name = await this.getActiveProviderName();
        const result = await this.providers[name].completeWithTools(opts);
        return { ...result, provider: name };
    }
};
exports.LlmService = LlmService;
exports.LlmService = LlmService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [platform_setting_service_1.PlatformSettingService,
        anthropic_provider_1.AnthropicProvider,
        openai_provider_1.OpenAiProvider])
], LlmService);
//# sourceMappingURL=llm.service.js.map