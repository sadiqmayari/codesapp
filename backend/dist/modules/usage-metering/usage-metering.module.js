"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UsageMeteringModule = void 0;
const common_1 = require("@nestjs/common");
const billing_module_1 = require("../billing/billing.module");
const usage_metering_service_1 = require("./usage-metering.service");
let UsageMeteringModule = class UsageMeteringModule {
};
exports.UsageMeteringModule = UsageMeteringModule;
exports.UsageMeteringModule = UsageMeteringModule = __decorate([
    (0, common_1.Module)({
        imports: [billing_module_1.BillingModule],
        providers: [usage_metering_service_1.UsageMeteringService],
        exports: [usage_metering_service_1.UsageMeteringService],
    })
], UsageMeteringModule);
//# sourceMappingURL=usage-metering.module.js.map