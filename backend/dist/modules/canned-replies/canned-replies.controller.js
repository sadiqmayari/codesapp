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
exports.CannedRepliesController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const tenant_guard_1 = require("../../common/guards/tenant.guard");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const canned_replies_service_1 = require("./canned-replies.service");
const create_canned_reply_dto_1 = require("./dto/create-canned-reply.dto");
const update_canned_reply_dto_1 = require("./dto/update-canned-reply.dto");
let CannedRepliesController = class CannedRepliesController {
    constructor(cannedReplies) {
        this.cannedReplies = cannedReplies;
    }
    list(user) {
        return this.cannedReplies.list(user.companyId);
    }
    create(user, dto) {
        return this.cannedReplies.create(user.companyId, dto);
    }
    update(user, id, dto) {
        return this.cannedReplies.update(user.companyId, id, dto);
    }
    remove(user, id) {
        return this.cannedReplies.remove(user.companyId, id);
    }
};
exports.CannedRepliesController = CannedRepliesController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], CannedRepliesController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, create_canned_reply_dto_1.CreateCannedReplyDto]),
    __metadata("design:returntype", void 0)
], CannedRepliesController.prototype, "create", null);
__decorate([
    (0, common_1.Patch)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, update_canned_reply_dto_1.UpdateCannedReplyDto]),
    __metadata("design:returntype", void 0)
], CannedRepliesController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], CannedRepliesController.prototype, "remove", null);
exports.CannedRepliesController = CannedRepliesController = __decorate([
    (0, common_1.Controller)('canned-replies'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __metadata("design:paramtypes", [canned_replies_service_1.CannedRepliesService])
], CannedRepliesController);
//# sourceMappingURL=canned-replies.controller.js.map