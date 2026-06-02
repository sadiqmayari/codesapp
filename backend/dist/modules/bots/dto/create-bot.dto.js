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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateBotDto = exports.BotActionDto = exports.BotActionType = exports.BotTriggerType = void 0;
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
var BotTriggerType;
(function (BotTriggerType) {
    BotTriggerType["exact"] = "exact";
    BotTriggerType["contains"] = "contains";
    BotTriggerType["regex"] = "regex";
})(BotTriggerType || (exports.BotTriggerType = BotTriggerType = {}));
var BotActionType;
(function (BotActionType) {
    BotActionType["reply_template"] = "reply_template";
    BotActionType["send_text"] = "send_text";
    BotActionType["assign_agent"] = "assign_agent";
    BotActionType["apply_tag"] = "apply_tag";
    BotActionType["fire_webhook"] = "fire_webhook";
    BotActionType["ai_reply"] = "ai_reply";
})(BotActionType || (exports.BotActionType = BotActionType = {}));
class BotActionDto {
}
exports.BotActionDto = BotActionDto;
__decorate([
    (0, class_validator_1.IsEnum)(BotActionType),
    __metadata("design:type", String)
], BotActionDto.prototype, "type", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], BotActionDto.prototype, "templateId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsObject)(),
    __metadata("design:type", Object)
], BotActionDto.prototype, "variables", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(4096),
    __metadata("design:type", String)
], BotActionDto.prototype, "message", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], BotActionDto.prototype, "userId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(64),
    __metadata("design:type", String)
], BotActionDto.prototype, "tag", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], BotActionDto.prototype, "webhookEndpointId", void 0);
class CreateBotDto {
}
exports.CreateBotDto = CreateBotDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(128),
    __metadata("design:type", String)
], CreateBotDto.prototype, "name", void 0);
__decorate([
    (0, class_validator_1.IsEnum)(BotTriggerType),
    __metadata("design:type", String)
], CreateBotDto.prototype, "triggerType", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(255),
    __metadata("design:type", String)
], CreateBotDto.prototype, "keyword", void 0);
__decorate([
    (0, class_validator_1.IsArray)(),
    (0, class_validator_1.ArrayMinSize)(1),
    (0, class_validator_1.ArrayMaxSize)(10),
    (0, class_validator_1.ValidateNested)({ each: true }),
    (0, class_transformer_1.Type)(() => BotActionDto),
    __metadata("design:type", Array)
], CreateBotDto.prototype, "actions", void 0);
//# sourceMappingURL=create-bot.dto.js.map