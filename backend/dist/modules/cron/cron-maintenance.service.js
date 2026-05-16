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
var CronMaintenanceService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CronMaintenanceService = void 0;
const common_1 = require("@nestjs/common");
const fs = require("fs/promises");
const prisma_service_1 = require("../../prisma/prisma.service");
const BATCH = 100;
let CronMaintenanceService = CronMaintenanceService_1 = class CronMaintenanceService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(CronMaintenanceService_1.name);
    }
    async cleanupMedia() {
        const start = Date.now();
        let processed = 0;
        let deleted = 0;
        let ioErrors = 0;
        for (;;) {
            const rows = await this.prisma.message.findMany({
                where: {
                    media_expires_at: { lt: new Date() },
                    media_expired: false,
                },
                select: { id: true, media_url: true },
                take: BATCH,
            });
            if (rows.length === 0)
                break;
            for (const row of rows) {
                processed++;
                if (row.media_url) {
                    try {
                        await fs.unlink(row.media_url);
                        deleted++;
                    }
                    catch (err) {
                        const code = err?.code;
                        if (code === 'ENOENT') {
                        }
                        else {
                            ioErrors++;
                            this.logger.warn(`media unlink failed for message ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
                        }
                    }
                }
                await this.prisma.message.update({
                    where: { id: row.id },
                    data: { media_expired: true },
                });
            }
            if (rows.length < BATCH)
                break;
        }
        return { processed, deleted, ioErrors, durationMs: Date.now() - start };
    }
    async cleanupOrphans() {
        const result = await this.prisma.$executeRawUnsafe(`UPDATE jobs SET status = 'pending', locked_until = NULL, locked_by = NULL
       WHERE status = 'processing' AND locked_until < NOW()`);
        return { released: Number(result) };
    }
    async purgeOldJobs() {
        const result = await this.prisma.$executeRawUnsafe(`DELETE FROM jobs
       WHERE status IN ('completed','failed')
         AND completed_at < (NOW() - INTERVAL 30 DAY)`);
        return { purged: Number(result) };
    }
};
exports.CronMaintenanceService = CronMaintenanceService;
exports.CronMaintenanceService = CronMaintenanceService = CronMaintenanceService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CronMaintenanceService);
//# sourceMappingURL=cron-maintenance.service.js.map