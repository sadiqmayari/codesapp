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
exports.SuperAdminController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const super_admin_service_1 = require("./super-admin.service");
const super_admin_ip_guard_1 = require("../../common/guards/super-admin-ip.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const roles_decorator_1 = require("../../common/decorators/roles.decorator");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const login_dto_1 = require("../auth/dto/login.dto");
let SuperAdminController = class SuperAdminController {
    constructor(superAdminService) {
        this.superAdminService = superAdminService;
    }
    login(dto, res) {
        return this.superAdminService.login(dto.email, dto.password, res);
    }
    getDashboard() {
        return this.superAdminService.getDashboard();
    }
    getClients(page = 1, limit = 20) {
        return this.superAdminService.getClients(page, limit);
    }
    getClient(id) {
        return this.superAdminService.getClient(id);
    }
    activateClient(id) {
        return this.superAdminService.activateClient(id);
    }
    suspendClient(id) {
        return this.superAdminService.suspendClient(id);
    }
    deleteClient(id) {
        return this.superAdminService.deleteClient(id);
    }
    getPlans() {
        return this.superAdminService.getPlans();
    }
    createPlan(body) {
        return this.superAdminService.createPlan(body);
    }
    updatePlan(id, body) {
        return this.superAdminService.updatePlan(id, body);
    }
    getInvoices(page = 1, limit = 20) {
        return this.superAdminService.getInvoices(page, limit);
    }
    getUsage() {
        return this.superAdminService.getUsage();
    }
    getAuditLogs(page = 1, limit = 50) {
        return this.superAdminService.getAuditLogs(page, limit);
    }
    impersonate(companyId, user) {
        return this.superAdminService.impersonate(companyId, user.userId);
    }
};
exports.SuperAdminController = SuperAdminController;
__decorate([
    (0, common_1.Post)('auth/login'),
    (0, common_1.UseGuards)(super_admin_ip_guard_1.SuperAdminIpGuard),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [login_dto_1.LoginDto, Object]),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "login", null);
__decorate([
    (0, common_1.Get)('dashboard'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), super_admin_ip_guard_1.SuperAdminIpGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('super_admin'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "getDashboard", null);
__decorate([
    (0, common_1.Get)('clients'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), super_admin_ip_guard_1.SuperAdminIpGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('super_admin'),
    __param(0, (0, common_1.Query)('page', new common_1.ParseIntPipe({ optional: true }))),
    __param(1, (0, common_1.Query)('limit', new common_1.ParseIntPipe({ optional: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "getClients", null);
__decorate([
    (0, common_1.Get)('clients/:id'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), super_admin_ip_guard_1.SuperAdminIpGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('super_admin'),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "getClient", null);
__decorate([
    (0, common_1.Patch)('clients/:id/activate'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), super_admin_ip_guard_1.SuperAdminIpGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('super_admin'),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "activateClient", null);
__decorate([
    (0, common_1.Patch)('clients/:id/suspend'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), super_admin_ip_guard_1.SuperAdminIpGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('super_admin'),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "suspendClient", null);
__decorate([
    (0, common_1.Delete)('clients/:id'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), super_admin_ip_guard_1.SuperAdminIpGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('super_admin'),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "deleteClient", null);
__decorate([
    (0, common_1.Get)('plans'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), super_admin_ip_guard_1.SuperAdminIpGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('super_admin'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "getPlans", null);
__decorate([
    (0, common_1.Post)('plans'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), super_admin_ip_guard_1.SuperAdminIpGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('super_admin'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "createPlan", null);
__decorate([
    (0, common_1.Patch)('plans/:id'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), super_admin_ip_guard_1.SuperAdminIpGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('super_admin'),
    __param(0, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Object]),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "updatePlan", null);
__decorate([
    (0, common_1.Get)('invoices'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), super_admin_ip_guard_1.SuperAdminIpGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('super_admin'),
    __param(0, (0, common_1.Query)('page', new common_1.ParseIntPipe({ optional: true }))),
    __param(1, (0, common_1.Query)('limit', new common_1.ParseIntPipe({ optional: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "getInvoices", null);
__decorate([
    (0, common_1.Get)('usage'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), super_admin_ip_guard_1.SuperAdminIpGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('super_admin'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "getUsage", null);
__decorate([
    (0, common_1.Get)('audit-logs'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), super_admin_ip_guard_1.SuperAdminIpGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('super_admin'),
    __param(0, (0, common_1.Query)('page', new common_1.ParseIntPipe({ optional: true }))),
    __param(1, (0, common_1.Query)('limit', new common_1.ParseIntPipe({ optional: true }))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "getAuditLogs", null);
__decorate([
    (0, common_1.Post)('impersonate/:companyId'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), super_admin_ip_guard_1.SuperAdminIpGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('super_admin'),
    __param(0, (0, common_1.Param)('companyId', common_1.ParseIntPipe)),
    __param(1, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number, Object]),
    __metadata("design:returntype", void 0)
], SuperAdminController.prototype, "impersonate", null);
exports.SuperAdminController = SuperAdminController = __decorate([
    (0, common_1.Controller)('super-admin'),
    __metadata("design:paramtypes", [super_admin_service_1.SuperAdminService])
], SuperAdminController);
//# sourceMappingURL=super-admin.controller.js.map