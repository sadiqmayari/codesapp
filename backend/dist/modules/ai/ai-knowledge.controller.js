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
exports.AiKnowledgeController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const tenant_guard_1 = require("../../common/guards/tenant.guard");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const ai_knowledge_service_1 = require("./ai-knowledge.service");
const knowledge_dto_1 = require("./dto/knowledge.dto");
let AiKnowledgeController = class AiKnowledgeController {
    constructor(knowledge) {
        this.knowledge = knowledge;
    }
    list(user) {
        return this.knowledge.list(user.companyId);
    }
    create(user, dto) {
        return this.knowledge.create(user.companyId, dto);
    }
    update(user, id, dto) {
        return this.knowledge.update(user.companyId, id, dto);
    }
    remove(user, id) {
        return this.knowledge.remove(user.companyId, id);
    }
};
exports.AiKnowledgeController = AiKnowledgeController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AiKnowledgeController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, knowledge_dto_1.CreateKnowledgeDto]),
    __metadata("design:returntype", void 0)
], AiKnowledgeController.prototype, "create", null);
__decorate([
    (0, common_1.Patch)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, knowledge_dto_1.UpdateKnowledgeDto]),
    __metadata("design:returntype", void 0)
], AiKnowledgeController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], AiKnowledgeController.prototype, "remove", null);
exports.AiKnowledgeController = AiKnowledgeController = __decorate([
    (0, common_1.Controller)('ai/knowledge'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __metadata("design:paramtypes", [ai_knowledge_service_1.AiKnowledgeService])
], AiKnowledgeController);
//# sourceMappingURL=ai-knowledge.controller.js.map