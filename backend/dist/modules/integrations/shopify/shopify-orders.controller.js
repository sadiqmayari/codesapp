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
exports.ShopifyOrdersController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const shopify_service_1 = require("./shopify.service");
const tenant_guard_1 = require("../../../common/guards/tenant.guard");
const roles_guard_1 = require("../../../common/guards/roles.guard");
const roles_decorator_1 = require("../../../common/decorators/roles.decorator");
const current_user_decorator_1 = require("../../../common/decorators/current-user.decorator");
const create_order_dto_1 = require("./dto/create-order.dto");
let ShopifyOrdersController = class ShopifyOrdersController {
    constructor(shopifyService) {
        this.shopifyService = shopifyService;
    }
    searchProducts(user, query) {
        return this.shopifyService.searchProducts(user.companyId, query ?? '');
    }
    shippingRates(user, dto) {
        return this.shopifyService.getShippingRates(user.companyId, dto);
    }
    searchCustomer(user, phone, email) {
        return this.shopifyService.searchCustomer(user.companyId, { phone, email });
    }
    createCustomer(user, dto) {
        return this.shopifyService.createCustomer(user.companyId, dto);
    }
    createOrder(user, dto) {
        return this.shopifyService.createOrder(user.companyId, dto);
    }
    syncKnowledge(user) {
        return this.shopifyService.syncKnowledge(user.companyId);
    }
};
exports.ShopifyOrdersController = ShopifyOrdersController;
__decorate([
    (0, common_1.Get)('products'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('query')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], ShopifyOrdersController.prototype, "searchProducts", null);
__decorate([
    (0, common_1.Post)('shipping-rates'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, create_order_dto_1.ShippingRatesDto]),
    __metadata("design:returntype", void 0)
], ShopifyOrdersController.prototype, "shippingRates", null);
__decorate([
    (0, common_1.Get)('customers'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('phone')),
    __param(2, (0, common_1.Query)('email')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], ShopifyOrdersController.prototype, "searchCustomer", null);
__decorate([
    (0, common_1.Post)('customers'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, create_order_dto_1.CreateCustomerDto]),
    __metadata("design:returntype", void 0)
], ShopifyOrdersController.prototype, "createCustomer", null);
__decorate([
    (0, common_1.Post)('orders'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, create_order_dto_1.CreateShopifyOrderDto]),
    __metadata("design:returntype", void 0)
], ShopifyOrdersController.prototype, "createOrder", null);
__decorate([
    (0, common_1.Post)('sync-knowledge'),
    (0, common_1.UseGuards)(roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('owner', 'admin'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ShopifyOrdersController.prototype, "syncKnowledge", null);
exports.ShopifyOrdersController = ShopifyOrdersController = __decorate([
    (0, common_1.Controller)('shopify'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard),
    __metadata("design:paramtypes", [shopify_service_1.ShopifyService])
], ShopifyOrdersController);
//# sourceMappingURL=shopify-orders.controller.js.map