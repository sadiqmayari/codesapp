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
exports.ListTemplatesDto = exports.TemplateStatus = void 0;
const class_validator_1 = require("class-validator");
const create_template_dto_1 = require("./create-template.dto");
var TemplateStatus;
(function (TemplateStatus) {
    TemplateStatus["pending"] = "pending";
    TemplateStatus["approved"] = "approved";
    TemplateStatus["rejected"] = "rejected";
    TemplateStatus["paused"] = "paused";
})(TemplateStatus || (exports.TemplateStatus = TemplateStatus = {}));
class ListTemplatesDto {
}
exports.ListTemplatesDto = ListTemplatesDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(TemplateStatus),
    __metadata("design:type", String)
], ListTemplatesDto.prototype, "status", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(create_template_dto_1.TemplateCategory),
    __metadata("design:type", String)
], ListTemplatesDto.prototype, "category", void 0);
//# sourceMappingURL=list-templates.dto.js.map