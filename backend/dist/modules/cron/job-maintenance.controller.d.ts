import { CronMaintenanceService } from './cron-maintenance.service';
export declare class JobMaintenanceController {
    private readonly maintenance;
    constructor(maintenance: CronMaintenanceService);
    cleanupOrphans(): Promise<{
        released: number;
    }>;
    purgeOld(): Promise<{
        purged: number;
    }>;
}
