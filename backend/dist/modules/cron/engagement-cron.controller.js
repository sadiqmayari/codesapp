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
exports.EngagementCronController = void 0;
const common_1 = require("@nestjs/common");
const cron_guard_1 = require("../../common/guards/cron.guard");
const work_item_service_1 = require("../engagement/work-item.service");
const engagement_metrics_service_1 = require("../engagement/engagement-metrics.service");
const HANDOFF_SLA_MS = 30 * 60 * 1000;
let EngagementCronController = class EngagementCronController {
    constructor(workItems, metrics) {
        this.workItems = workItems;
        this.metrics = metrics;
    }
    slaSweep() {
        return this.workItems.sweepOverdueHandoffs(HANDOFF_SLA_MS);
    }
    getMetrics() {
        return this.metrics.snapshot();
    }
};
exports.EngagementCronController = EngagementCronController;
__decorate([
    (0, common_1.Get)('sla-sweep'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], EngagementCronController.prototype, "slaSweep", null);
__decorate([
    (0, common_1.Get)('metrics'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], EngagementCronController.prototype, "getMetrics", null);
exports.EngagementCronController = EngagementCronController = __decorate([
    (0, common_1.Controller)('cron/engagement'),
    (0, common_1.UseGuards)(cron_guard_1.CronGuard),
    __metadata("design:paramtypes", [work_item_service_1.WorkItemService,
        engagement_metrics_service_1.EngagementMetricsService])
], EngagementCronController);
//# sourceMappingURL=engagement-cron.controller.js.map