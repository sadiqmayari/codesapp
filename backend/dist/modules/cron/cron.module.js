"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CronModule = void 0;
const common_1 = require("@nestjs/common");
const media_cleanup_controller_1 = require("./media-cleanup.controller");
const job_maintenance_controller_1 = require("./job-maintenance.controller");
const engagement_cron_controller_1 = require("./engagement-cron.controller");
const cron_maintenance_service_1 = require("./cron-maintenance.service");
const engagement_module_1 = require("../engagement/engagement.module");
let CronModule = class CronModule {
};
exports.CronModule = CronModule;
exports.CronModule = CronModule = __decorate([
    (0, common_1.Module)({
        imports: [engagement_module_1.EngagementModule],
        controllers: [
            media_cleanup_controller_1.MediaCleanupController,
            job_maintenance_controller_1.JobMaintenanceController,
            engagement_cron_controller_1.EngagementCronController,
        ],
        providers: [cron_maintenance_service_1.CronMaintenanceService],
    })
], CronModule);
//# sourceMappingURL=cron.module.js.map