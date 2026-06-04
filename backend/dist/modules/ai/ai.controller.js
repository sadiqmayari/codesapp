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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const tenant_guard_1 = require("../../common/guards/tenant.guard");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const ai_service_1 = require("./ai.service");
const ai_metering_service_1 = require("./ai-metering.service");
const ai_actions_dto_1 = require("./dto/ai-actions.dto");
let AiController = class AiController {
    constructor(ai, metering) {
        this.ai = ai;
        this.metering = metering;
    }
    suggestReply(user, dto) {
        return this.ai.suggestReply(user.companyId, user.userId, dto.conversationId, dto.instruction);
    }
    summarize(user, dto) {
        return this.ai.summarize(user.companyId, user.userId, dto.conversationId);
    }
    rewrite(user, dto) {
        return this.ai.rewrite(user.companyId, user.userId, dto.text, dto.mode);
    }
    translate(user, dto) {
        return this.ai.translate(user.companyId, user.userId, dto.text, dto.targetLang);
    }
    draftOrder(user, dto) {
        return this.ai.draftOrder(user.companyId, user.userId, dto.conversationId);
    }
    usage(user) {
        return this.metering.getMonthlyUsage(user.companyId);
    }
};
exports.AiController = AiController;
__decorate([
    (0, common_1.Post)('suggest-reply'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, ai_actions_dto_1.SuggestReplyDto]),
    __metadata("design:returntype", void 0)
], AiController.prototype, "suggestReply", null);
__decorate([
    (0, common_1.Post)('summarize'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, ai_actions_dto_1.SummarizeDto]),
    __metadata("design:returntype", void 0)
], AiController.prototype, "summarize", null);
__decorate([
    (0, common_1.Post)('rewrite'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, ai_actions_dto_1.RewriteDto]),
    __metadata("design:returntype", void 0)
], AiController.prototype, "rewrite", null);
__decorate([
    (0, common_1.Post)('translate'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, ai_actions_dto_1.TranslateDto]),
    __metadata("design:returntype", void 0)
], AiController.prototype, "translate", null);
__decorate([
    (0, common_1.Post)('draft-order'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, ai_actions_dto_1.DraftOrderDto]),
    __metadata("design:returntype", void 0)
], AiController.prototype, "draftOrder", null);
__decorate([
    (0, common_1.Get)('usage'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AiController.prototype, "usage", null);
exports.AiController = AiController = __decorate([
    (0, common_1.Controller)('ai'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __metadata("design:paramtypes", [ai_service_1.AiService,
        ai_metering_service_1.AiMeteringService])
], AiController);
//# sourceMappingURL=ai.controller.js.map