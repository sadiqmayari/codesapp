import { CronMaintenanceService } from './cron-maintenance.service';
export declare class MediaCleanupController {
    private readonly maintenance;
    constructor(maintenance: CronMaintenanceService);
    cleanupMedia(): Promise<{
        processed: number;
        deleted: number;
        ioErrors: number;
        durationMs: number;
    }>;
}
