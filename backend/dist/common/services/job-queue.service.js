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
var JobQueueService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobQueueService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const uuid_1 = require("uuid");
const LEASE_SECONDS = 30;
const POLL_INTERVAL_MS = 2000;
const BACKOFF_SECONDS = [60, 300, 1800];
const INSTANCE_ID = (0, uuid_1.v4)();
let JobQueueService = JobQueueService_1 = class JobQueueService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(JobQueueService_1.name);
        this.workers = new Map();
        this.pollTimer = null;
        this.stopped = false;
    }
    onModuleInit() {
        this.stopped = false;
        this.scheduleNextPoll();
        this.logger.log('Job queue poller started (every 2s, non-overlapping)');
    }
    onModuleDestroy() {
        this.stopped = true;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }
    scheduleNextPoll() {
        if (this.stopped)
            return;
        this.pollTimer = setTimeout(async () => {
            try {
                await this.poll();
            }
            catch (err) {
                this.logger.warn(`Job poll cycle failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            finally {
                this.scheduleNextPoll();
            }
        }, POLL_INTERVAL_MS);
    }
    async enqueue(queueName, payload, opts = {}) {
        const runAt = opts.delayMs
            ? new Date(Date.now() + opts.delayMs)
            : new Date();
        const job = await this.prisma.job.create({
            data: {
                queue_name: queueName,
                payload: payload,
                status: 'pending',
                max_attempts: opts.maxAttempts ?? 3,
                run_at: runAt,
            },
        });
        return job.id;
    }
    registerWorker(queueName, handler, concurrency = 3) {
        this.workers.set(queueName, { handler, concurrency, activeSlots: 0 });
        this.logger.log(`Worker registered for queue: ${queueName} (concurrency: ${concurrency})`);
    }
    async poll() {
        this.logger.verbose('polling jobs');
        for (const [queueName, worker] of this.workers.entries()) {
            const available = worker.concurrency - worker.activeSlots;
            if (available <= 0)
                continue;
            const now = new Date();
            const leaseExpiry = new Date(Date.now() + LEASE_SECONDS * 1000);
            let jobs;
            try {
                jobs = await this.prisma.$queryRaw `
          SELECT id FROM jobs
          WHERE queue_name = ${queueName}
            AND status = 'pending'
            AND run_at <= ${now}
            AND (locked_until IS NULL OR locked_until < ${now})
          ORDER BY run_at
          LIMIT ${available}
          FOR UPDATE SKIP LOCKED
        `;
            }
            catch {
                continue;
            }
            if (!jobs.length)
                continue;
            await this.prisma.job.updateMany({
                where: { id: { in: jobs.map((j) => j.id) } },
                data: {
                    status: 'processing',
                    locked_until: leaseExpiry,
                    locked_by: INSTANCE_ID,
                },
            });
            for (const { id } of jobs) {
                worker.activeSlots++;
                this.runJob(id, worker).finally(() => {
                    worker.activeSlots--;
                });
            }
        }
    }
    async runJob(jobId, worker) {
        const job = await this.prisma.job.findUnique({ where: { id: jobId } });
        if (!job)
            return;
        try {
            await worker.handler(job.payload);
            await this.prisma.job.update({
                where: { id: jobId },
                data: { status: 'completed', completed_at: new Date() },
            });
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const attempts = job.attempts + 1;
            const failed = attempts >= job.max_attempts;
            const backoffSecs = BACKOFF_SECONDS[attempts - 1] ?? 1800;
            await this.prisma.job.update({
                where: { id: jobId },
                data: {
                    attempts,
                    last_error: errMsg,
                    status: failed ? 'failed' : 'pending',
                    locked_until: null,
                    locked_by: null,
                    run_at: failed
                        ? job.run_at
                        : new Date(Date.now() + backoffSecs * 1000),
                },
            });
            this.logger.warn(`Job ${jobId} failed (attempt ${attempts}): ${errMsg}`);
        }
    }
};
exports.JobQueueService = JobQueueService;
exports.JobQueueService = JobQueueService = JobQueueService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], JobQueueService);
//# sourceMappingURL=job-queue.service.js.map