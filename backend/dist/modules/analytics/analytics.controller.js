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
exports.AnalyticsController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const tenant_guard_1 = require("../../common/guards/tenant.guard");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const analytics_service_1 = require("./analytics.service");
const date_range_dto_1 = require("./dtos/date-range.dto");
const dashboard_dto_1 = require("./dtos/dashboard.dto");
let AnalyticsController = class AnalyticsController {
    constructor(analytics) {
        this.analytics = analytics;
    }
    dashboard(user, dto) {
        return this.analytics.dashboard(user.companyId, dto);
    }
    overview(user) {
        return this.analytics.overview(user.companyId);
    }
    funnel(user, dto) {
        return this.analytics.funnel(user.companyId, dto);
    }
    agents(user, dto) {
        return this.analytics.agents(user.companyId, dto);
    }
    conversationCost(user, dto) {
        return this.analytics.conversationCost(user.companyId, dto);
    }
    usage(user) {
        return this.analytics.usage(user.companyId);
    }
    broadcast(user, id) {
        return this.analytics.broadcast(user.companyId, id);
    }
};
exports.AnalyticsController = AnalyticsController;
__decorate([
    (0, common_1.Get)('dashboard'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, dashboard_dto_1.DashboardDto]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "dashboard", null);
__decorate([
    (0, common_1.Get)('overview'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "overview", null);
__decorate([
    (0, common_1.Get)('funnel'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, date_range_dto_1.DateRangeDto]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "funnel", null);
__decorate([
    (0, common_1.Get)('agents'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, date_range_dto_1.DateRangeDto]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "agents", null);
__decorate([
    (0, common_1.Get)('conversation-cost'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, date_range_dto_1.DateRangeDto]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "conversationCost", null);
__decorate([
    (0, common_1.Get)('usage'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "usage", null);
__decorate([
    (0, common_1.Get)('broadcasts/:id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], AnalyticsController.prototype, "broadcast", null);
exports.AnalyticsController = AnalyticsController = __decorate([
    (0, common_1.Controller)('analytics'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __metadata("design:paramtypes", [analytics_service_1.AnalyticsService])
], AnalyticsController);
//# sourceMappingURL=analytics.controller.js.map