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
exports.WebhooksController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const tenant_guard_1 = require("../../common/guards/tenant.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const roles_decorator_1 = require("../../common/decorators/roles.decorator");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const webhooks_service_1 = require("./webhooks.service");
const create_endpoint_dto_1 = require("./dtos/create-endpoint.dto");
const update_endpoint_dto_1 = require("./dtos/update-endpoint.dto");
const list_logs_dto_1 = require("./dtos/list-logs.dto");
let WebhooksController = class WebhooksController {
    constructor(webhooks) {
        this.webhooks = webhooks;
    }
    listEndpoints(user, page = 1, limit = 20) {
        return this.webhooks.listEndpoints(user.companyId, page, limit);
    }
    listLogs(user, dto) {
        return this.webhooks.listLogs(user.companyId, dto);
    }
    getEndpoint(user, id) {
        return this.webhooks.getEndpoint(user.companyId, id);
    }
    create(user, dto) {
        return this.webhooks.createEndpoint(user.companyId, dto);
    }
    update(user, id, dto) {
        return this.webhooks.updateEndpoint(user.companyId, id, dto);
    }
    remove(user, id) {
        return this.webhooks.deleteEndpoint(user.companyId, id);
    }
    toggle(user, id) {
        return this.webhooks.toggleEndpoint(user.companyId, id);
    }
    test(user, id) {
        return this.webhooks.testEndpoint(user.companyId, id);
    }
    retry(user, id) {
        return this.webhooks.retryLog(user.companyId, id);
    }
};
exports.WebhooksController = WebhooksController;
__decorate([
    (0, common_1.Get)('endpoints'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('page', new common_1.ParseIntPipe({ optional: true }))),
    __param(2, (0, common_1.Query)('limit', new common_1.ParseIntPipe({ optional: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", void 0)
], WebhooksController.prototype, "listEndpoints", null);
__decorate([
    (0, common_1.Get)('logs'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, list_logs_dto_1.ListLogsDto]),
    __metadata("design:returntype", void 0)
], WebhooksController.prototype, "listLogs", null);
__decorate([
    (0, common_1.Get)('endpoints/:id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], WebhooksController.prototype, "getEndpoint", null);
__decorate([
    (0, common_1.Post)('endpoints'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('owner', 'admin'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, create_endpoint_dto_1.CreateEndpointDto]),
    __metadata("design:returntype", void 0)
], WebhooksController.prototype, "create", null);
__decorate([
    (0, common_1.Patch)('endpoints/:id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('owner', 'admin'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number, update_endpoint_dto_1.UpdateEndpointDto]),
    __metadata("design:returntype", void 0)
], WebhooksController.prototype, "update", null);
__decorate([
    (0, common_1.Delete)('endpoints/:id'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('owner', 'admin'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], WebhooksController.prototype, "remove", null);
__decorate([
    (0, common_1.Patch)('endpoints/:id/toggle'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('owner', 'admin'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], WebhooksController.prototype, "toggle", null);
__decorate([
    (0, common_1.Post)('endpoints/:id/test'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('owner', 'admin'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], WebhooksController.prototype, "test", null);
__decorate([
    (0, common_1.Post)('logs/:id/retry'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('owner', 'admin'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], WebhooksController.prototype, "retry", null);
exports.WebhooksController = WebhooksController = __decorate([
    (0, common_1.Controller)('webhooks'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __metadata("design:paramtypes", [webhooks_service_1.WebhooksService])
], WebhooksController);
//# sourceMappingURL=webhooks.controller.js.map