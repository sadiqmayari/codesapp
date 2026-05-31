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
exports.BroadcastsController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const tenant_guard_1 = require("../../common/guards/tenant.guard");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const broadcasts_service_1 = require("./broadcasts.service");
const broadcast_plan_guard_1 = require("./broadcast-plan.guard");
const create_broadcast_dto_1 = require("./dto/create-broadcast.dto");
const schedule_broadcast_dto_1 = require("./dto/schedule-broadcast.dto");
const list_broadcasts_dto_1 = require("./dto/list-broadcasts.dto");
const preview_audience_dto_1 = require("./dto/preview-audience.dto");
const test_send_dto_1 = require("./dto/test-send.dto");
let BroadcastsController = class BroadcastsController {
    constructor(broadcastsService) {
        this.broadcastsService = broadcastsService;
    }
    list(user, dto) {
        return this.broadcastsService.list(user.companyId, dto);
    }
    previewAudience(user, dto) {
        return this.broadcastsService.previewAudience(user.companyId, dto);
    }
    testSend(user, dto) {
        return this.broadcastsService.testSend(user.companyId, dto);
    }
    get(user, id) {
        return this.broadcastsService.get(user.companyId, id);
    }
    create(user, dto) {
        return this.broadcastsService.create(user.companyId, dto);
    }
    duplicate(user, id) {
        return this.broadcastsService.duplicate(user.companyId, id);
    }
    update(user, id, dto) {
        return this.broadcastsService.update(user.companyId, id, dto);
    }
    send(user, id) {
        return this.broadcastsService.sendNow(user.companyId, id);
    }
    schedule(user, id, dto) {
        return this.broadcastsService.schedule(user.companyId, id, dto);
    }
    cancel(user, id) {
        return this.broadcastsService.cancel(user.companyId, id);
    }
    analytics(user, id) {
        return this.broadcastsService.analytics(user.companyId, id);
    }
};
exports.BroadcastsController = BroadcastsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, list_broadcasts_dto_1.ListBroadcastsDto]),
    __metadata("design:returntype", void 0)
], BroadcastsController.prototype, "list", null);
__decorate([
    (0, common_1.Post)('preview-audience'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, preview_audience_dto_1.PreviewAudienceDto]),
    __metadata("design:returntype", void 0)
], BroadcastsController.prototype, "previewAudience", null);
__decorate([
    (0, common_1.Post)('test-send'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, test_send_dto_1.TestSendDto]),
    __metadata("design:returntype", void 0)
], BroadcastsController.prototype, "testSend", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], BroadcastsController.prototype, "get", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, create_broadcast_dto_1.CreateBroadcastDto]),
    __metadata("design:returntype", void 0)
], BroadcastsController.prototype, "create", null);
__decorate([
    (0, common_1.Post)(':id/duplicate'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], BroadcastsController.prototype, "duplicate", null);
__decorate([
    (0, common_1.Patch)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, create_broadcast_dto_1.CreateBroadcastDto]),
    __metadata("design:returntype", void 0)
], BroadcastsController.prototype, "update", null);
__decorate([
    (0, common_1.Post)(':id/send'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], BroadcastsController.prototype, "send", null);
__decorate([
    (0, common_1.Post)(':id/schedule'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, schedule_broadcast_dto_1.ScheduleBroadcastDto]),
    __metadata("design:returntype", void 0)
], BroadcastsController.prototype, "schedule", null);
__decorate([
    (0, common_1.Post)(':id/cancel'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], BroadcastsController.prototype, "cancel", null);
__decorate([
    (0, common_1.Get)(':id/analytics'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], BroadcastsController.prototype, "analytics", null);
exports.BroadcastsController = BroadcastsController = __decorate([
    (0, common_1.Controller)('broadcasts'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard, broadcast_plan_guard_1.BroadcastPlanGuard),
    __metadata("design:paramtypes", [broadcasts_service_1.BroadcastsService])
], BroadcastsController);
//# sourceMappingURL=broadcasts.controller.js.map