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
exports.JobMaintenanceController = void 0;
const common_1 = require("@nestjs/common");
const cron_guard_1 = require("../../common/guards/cron.guard");
const cron_maintenance_service_1 = require("./cron-maintenance.service");
let JobMaintenanceController = class JobMaintenanceController {
    constructor(maintenance) {
        this.maintenance = maintenance;
    }
    cleanupOrphans() {
        return this.maintenance.cleanupOrphans();
    }
    purgeOld() {
        return this.maintenance.purgeOldJobs();
    }
};
exports.JobMaintenanceController = JobMaintenanceController;
__decorate([
    (0, common_1.Get)('cleanup-orphans'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], JobMaintenanceController.prototype, "cleanupOrphans", null);
__decorate([
    (0, common_1.Get)('purge-old'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], JobMaintenanceController.prototype, "purgeOld", null);
exports.JobMaintenanceController = JobMaintenanceController = __decorate([
    (0, common_1.Controller)('cron/jobs'),
    (0, common_1.UseGuards)(cron_guard_1.CronGuard),
    __metadata("design:paramtypes", [cron_maintenance_service_1.CronMaintenanceService])
], JobMaintenanceController);
//# sourceMappingURL=job-maintenance.controller.js.map