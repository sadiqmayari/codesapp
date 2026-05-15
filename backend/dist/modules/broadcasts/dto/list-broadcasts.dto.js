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
exports.ListBroadcastsDto = exports.BroadcastStatusFilter = void 0;
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
var BroadcastStatusFilter;
(function (BroadcastStatusFilter) {
    BroadcastStatusFilter["draft"] = "draft";
    BroadcastStatusFilter["scheduled"] = "scheduled";
    BroadcastStatusFilter["sending"] = "sending";
    BroadcastStatusFilter["completed"] = "completed";
    BroadcastStatusFilter["failed"] = "failed";
    BroadcastStatusFilter["cancelled"] = "cancelled";
})(BroadcastStatusFilter || (exports.BroadcastStatusFilter = BroadcastStatusFilter = {}));
class ListBroadcastsDto {
}
exports.ListBroadcastsDto = ListBroadcastsDto;
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsEnum)(BroadcastStatusFilter),
    __metadata("design:type", String)
], ListBroadcastsDto.prototype, "status", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], ListBroadcastsDto.prototype, "page", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    (0, class_validator_1.Max)(100),
    (0, class_transformer_1.Type)(() => Number),
    __metadata("design:type", Number)
], ListBroadcastsDto.prototype, "limit", void 0);
//# sourceMappingURL=list-broadcasts.dto.js.map