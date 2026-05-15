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
exports.SegmentsController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const tenant_guard_1 = require("../../common/guards/tenant.guard");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const segments_service_1 = require("./segments.service");
const create_segment_dto_1 = require("./dto/create-segment.dto");
let SegmentsController = class SegmentsController {
    constructor(segmentsService) {
        this.segmentsService = segmentsService;
    }
    list(user) {
        return this.segmentsService.list(user.companyId);
    }
    create(user, dto) {
        return this.segmentsService.create(user.companyId, dto);
    }
    update(user, id, dto) {
        return this.segmentsService.update(user.companyId, id, dto);
    }
    remove(user, id) {
        return this.segmentsService.delete(user.companyId, id);
    }
    preview(user, id, limit) {
        return this.segmentsService.preview(user.companyId, id, limit ? Number(limit) : 20);
    }
};
exports.SegmentsController = SegmentsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SegmentsController.prototype, "list", null);
__decorate([
    (0, common_1.Post)(),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, create_segment_dto_1.CreateSegmentDto]),
    __metadata("design:returntype", void 0)
], SegmentsController.prototype, "create", null);
__decorate([
    (0, common_1.Patch)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, create_segment_dto_1.UpdateSegmentDto]),
    __metadata("design:returntype", void 0)
], SegmentsController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)(':id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], SegmentsController.prototype, "remove", null);
__decorate([
    (0, common_1.Get)(':id/preview'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, String]),
    __metadata("design:returntype", void 0)
], SegmentsController.prototype, "preview", null);
exports.SegmentsController = SegmentsController = __decorate([
    (0, common_1.Controller)('contacts/segments'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __metadata("design:paramtypes", [segments_service_1.SegmentsService])
], SegmentsController);
//# sourceMappingURL=segments.controller.js.map