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
exports.BillingController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const tenant_guard_1 = require("../../common/guards/tenant.guard");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const billing_service_1 = require("./billing.service");
const list_invoices_dto_1 = require("./dtos/list-invoices.dto");
let BillingController = class BillingController {
    constructor(billing) {
        this.billing = billing;
    }
    listInvoices(user, dto) {
        return this.billing.listInvoices(user.companyId, dto);
    }
    subscription(user) {
        return this.billing.getSubscription(user.companyId);
    }
    getInvoice(user, id) {
        return this.billing.getInvoice(user.companyId, id);
    }
};
exports.BillingController = BillingController;
__decorate([
    (0, common_1.Get)('invoices'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, list_invoices_dto_1.ListInvoicesDto]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "listInvoices", null);
__decorate([
    (0, common_1.Get)('subscription'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "subscription", null);
__decorate([
    (0, common_1.Get)('invoices/:id'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id', common_1.ParseIntPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Number]),
    __metadata("design:returntype", void 0)
], BillingController.prototype, "getInvoice", null);
exports.BillingController = BillingController = __decorate([
    (0, common_1.Controller)('billing'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __metadata("design:paramtypes", [billing_service_1.BillingService])
], BillingController);
//# sourceMappingURL=billing.controller.js.map