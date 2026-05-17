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
exports.OnboardingController = void 0;
const common_1 = require("@nestjs/common");
const passport_1 = require("@nestjs/passport");
const tenant_guard_1 = require("../../common/guards/tenant.guard");
const roles_guard_1 = require("../../common/guards/roles.guard");
const roles_decorator_1 = require("../../common/decorators/roles.decorator");
const current_user_decorator_1 = require("../../common/decorators/current-user.decorator");
const onboarding_service_1 = require("./onboarding.service");
const step_1_meta_app_dto_1 = require("./dtos/step-1-meta-app.dto");
const step_3_access_token_dto_1 = require("./dtos/step-3-access-token.dto");
const step_4_waba_phone_dto_1 = require("./dtos/step-4-waba-phone.dto");
const step_5_test_message_dto_1 = require("./dtos/step-5-test-message.dto");
let OnboardingController = class OnboardingController {
    constructor(onboarding) {
        this.onboarding = onboarding;
    }
    status(user) {
        return this.onboarding.getStatus(user.companyId);
    }
    step1(user, dto) {
        return this.onboarding.step1(user.companyId, dto);
    }
    step2(user) {
        return this.onboarding.step2(user.companyId);
    }
    step3(user, dto) {
        return this.onboarding.step3(user.companyId, dto);
    }
    step4(user, dto) {
        return this.onboarding.step4(user.companyId, dto);
    }
    step5(user, dto) {
        return this.onboarding.step5(user.companyId, dto);
    }
    complete(user) {
        return this.onboarding.completeWithoutTest(user.companyId);
    }
    reset(user) {
        return this.onboarding.reset(user.companyId);
    }
};
exports.OnboardingController = OnboardingController;
__decorate([
    (0, common_1.Get)('status'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], OnboardingController.prototype, "status", null);
__decorate([
    (0, common_1.Post)('step-1-meta-app'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, step_1_meta_app_dto_1.Step1MetaAppDto]),
    __metadata("design:returntype", void 0)
], OnboardingController.prototype, "step1", null);
__decorate([
    (0, common_1.Post)('step-2-webhook-verify'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], OnboardingController.prototype, "step2", null);
__decorate([
    (0, common_1.Post)('step-3-access-token'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, step_3_access_token_dto_1.Step3AccessTokenDto]),
    __metadata("design:returntype", void 0)
], OnboardingController.prototype, "step3", null);
__decorate([
    (0, common_1.Post)('step-4-waba-phone'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, step_4_waba_phone_dto_1.Step4WabaPhoneDto]),
    __metadata("design:returntype", void 0)
], OnboardingController.prototype, "step4", null);
__decorate([
    (0, common_1.Post)('step-5-test-message'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, step_5_test_message_dto_1.Step5TestMessageDto]),
    __metadata("design:returntype", void 0)
], OnboardingController.prototype, "step5", null);
__decorate([
    (0, common_1.Post)('complete'),
    (0, roles_decorator_1.Roles)('owner'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], OnboardingController.prototype, "complete", null);
__decorate([
    (0, common_1.Post)('reset'),
    (0, roles_decorator_1.Roles)('owner'),
    __param(0, (0, current_user_decorator_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], OnboardingController.prototype, "reset", null);
exports.OnboardingController = OnboardingController = __decorate([
    (0, common_1.Controller)('onboarding'),
    (0, common_1.UseGuards)((0, passport_1.AuthGuard)('jwt'), tenant_guard_1.TenantGuard, roles_guard_1.RolesGuard),
    (0, roles_decorator_1.Roles)('owner', 'admin'),
    __metadata("design:paramtypes", [onboarding_service_1.OnboardingService])
], OnboardingController);
//# sourceMappingURL=onboarding.controller.js.map