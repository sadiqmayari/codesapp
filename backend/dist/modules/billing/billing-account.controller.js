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
exports.BillingAccountController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const tenant_guard_1 = require("../../common/guards/tenant.guard");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const billing_service_1 = require("./billing.service");
const limit_notifier_service_1 = require("./limit-notifier.service");
let BillingAccountController = class BillingAccountController {
    constructor(billing, limitNotifier) {
        this.billing = billing;
        this.limitNotifier = limitNotifier;
    }
    accountStatus(user) {
        return this.billing.accountStatus(user.companyId);
    }
    usageWarnings(user) {
        return this.limitNotifier.snapshot(user.companyId);
    }
};
exports.BillingAccountController = BillingAccountController;
__decorate([
    (0, common_1.Get)('account-status'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt')),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], BillingAccountController.prototype, "accountStatus", null);
__decorate([
    (0, common_1.Get)('usage-warnings'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], BillingAccountController.prototype, "usageWarnings", null);
exports.BillingAccountController = BillingAccountController = __decorate([
    (0, common_1.Controller)('billing'),
    __metadata("design:paramtypes", [billing_service_1.BillingService,
        limit_notifier_service_1.LimitNotifierService])
], BillingAccountController);
//# sourceMappingURL=billing-account.controller.js.map