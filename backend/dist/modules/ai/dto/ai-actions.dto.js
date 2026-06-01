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
exports.TranslateDto = exports.RewriteDto = exports.SummarizeDto = exports.SuggestReplyDto = void 0;
const class_validator_1 = require("class-validator");
class SuggestReplyDto {
}
exports.SuggestReplyDto = SuggestReplyDto;
__decorate([
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], SuggestReplyDto.prototype, "conversationId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MaxLength)(500),
    __metadata("design:type", String)
], SuggestReplyDto.prototype, "instruction", void 0);
class SummarizeDto {
}
exports.SummarizeDto = SummarizeDto;
__decorate([
    (0, class_validator_1.IsInt)(),
    __metadata("design:type", Number)
], SummarizeDto.prototype, "conversationId", void 0);
class RewriteDto {
}
exports.RewriteDto = RewriteDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(4000),
    __metadata("design:type", String)
], RewriteDto.prototype, "text", void 0);
__decorate([
    (0, class_validator_1.IsIn)(['polite', 'shorten', 'expand', 'fix']),
    __metadata("design:type", String)
], RewriteDto.prototype, "mode", void 0);
class TranslateDto {
}
exports.TranslateDto = TranslateDto;
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    (0, class_validator_1.MaxLength)(4000),
    __metadata("design:type", String)
], TranslateDto.prototype, "text", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(2),
    (0, class_validator_1.MaxLength)(32),
    __metadata("design:type", String)
], TranslateDto.prototype, "targetLang", void 0);
//# sourceMappingURL=ai-actions.dto.js.map