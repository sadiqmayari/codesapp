"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiModule = void 0;
const common_1 = require("@nestjs/common");
const auth_module_1 = require("../auth/auth.module");
const ai_controller_1 = require("./ai.controller");
const ai_knowledge_controller_1 = require("./ai-knowledge.controller");
const ai_settings_controller_1 = require("./ai-settings.controller");
const ai_service_1 = require("./ai.service");
const ai_knowledge_service_1 = require("./ai-knowledge.service");
const ai_settings_service_1 = require("./ai-settings.service");
const ai_metering_service_1 = require("./ai-metering.service");
const llm_service_1 = require("./llm.service");
const anthropic_provider_1 = require("./providers/anthropic.provider");
const openai_provider_1 = require("./providers/openai.provider");
let AiModule = class AiModule {
};
exports.AiModule = AiModule;
exports.AiModule = AiModule = __decorate([
    (0, common_1.Module)({
        imports: [auth_module_1.AuthModule],
        controllers: [ai_controller_1.AiController, ai_knowledge_controller_1.AiKnowledgeController, ai_settings_controller_1.AiSettingsController],
        providers: [
            ai_service_1.AiService,
            ai_knowledge_service_1.AiKnowledgeService,
            ai_settings_service_1.AiSettingsService,
            ai_metering_service_1.AiMeteringService,
            llm_service_1.LlmService,
            anthropic_provider_1.AnthropicProvider,
            openai_provider_1.OpenAiProvider,
        ],
        exports: [ai_service_1.AiService, ai_metering_service_1.AiMeteringService],
    })
], AiModule);
//# sourceMappingURL=ai.module.js.map