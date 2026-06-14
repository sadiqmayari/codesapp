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
exports.EngagementMetricsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let EngagementMetricsService = class EngagementMetricsService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async snapshot() {
        const [jobsByQueueStatus, oldestPending, deadLetter, outboxByState, workItemsByTypeStatus, overdueHandoffs, eventsLast24h,] = await Promise.all([
            this.prisma.job.groupBy({
                by: ['queue_name', 'status'],
                _count: { _all: true },
            }),
            this.prisma.job.findFirst({
                where: { status: 'pending' },
                orderBy: { run_at: 'asc' },
                select: { run_at: true, queue_name: true },
            }),
            this.prisma.job.findMany({
                where: { status: 'failed' },
                orderBy: { run_at: 'desc' },
                take: 20,
                select: {
                    id: true,
                    queue_name: true,
                    attempts: true,
                    last_error: true,
                    run_at: true,
                },
            }),
            this.prisma.outbox.groupBy({
                by: ['state'],
                _count: { _all: true },
            }),
            this.prisma.workItem.groupBy({
                by: ['type', 'status'],
                _count: { _all: true },
            }),
            this.prisma.workItem.count({
                where: {
                    owner: 'HUMAN',
                    status: 'OPEN',
                    assigned_user_id: null,
                    expires_at: { not: null, lt: new Date() },
                },
            }),
            this.prisma.event.count({
                where: { created_at: { gt: new Date(Date.now() - 86_400_000) } },
            }),
        ]);
        const queues = {};
        for (const r of jobsByQueueStatus) {
            (queues[r.queue_name] ??= {})[r.status] = r._count._all;
        }
        return {
            timestamp: new Date().toISOString(),
            queues,
            oldestPendingJob: oldestPending
                ? {
                    queue: oldestPending.queue_name,
                    ageSec: Math.round((Date.now() - new Date(oldestPending.run_at).getTime()) / 1000),
                }
                : null,
            deadLetter: { count: deadLetter.length, recent: deadLetter },
            outbox: Object.fromEntries(outboxByState.map((r) => [r.state, r._count._all])),
            workItems: workItemsByTypeStatus.map((r) => ({
                type: r.type,
                status: r.status,
                count: r._count._all,
            })),
            overdueHandoffs,
            eventsLast24h,
        };
    }
};
exports.EngagementMetricsService = EngagementMetricsService;
exports.EngagementMetricsService = EngagementMetricsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], EngagementMetricsService);
//# sourceMappingURL=engagement-metrics.service.js.map