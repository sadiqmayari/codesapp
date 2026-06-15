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
const client_1 = require("@prisma/client");
const uuid_1 = require("uuid");
const DEFAULT_LEASE_SECONDS = 30;
const POLL_INTERVAL_MS = 2000;
const BACKOFF_SECONDS = [60, 300, 1800];
const INSTANCE_ID = (0, uuid_1.v4)();
const SERIAL_SCAN_MULTIPLIER = 3;
const SERIAL_SCAN_CAP = 20;
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
        try {
            const job = await this.prisma.job.create({
                data: {
                    queue_name: queueName,
                    payload: payload,
                    status: 'pending',
                    max_attempts: opts.maxAttempts ?? 3,
                    run_at: runAt,
                    serial_key: opts.serialKey ?? null,
                    dedup_key: opts.dedupKey ?? null,
                    priority: opts.priority ?? 5,
                },
            });
            return job.id;
        }
        catch (err) {
            if (err instanceof client_1.Prisma.PrismaClientKnownRequestError &&
                err.code === 'P2002' &&
                opts.dedupKey) {
                this.logger.debug(`enqueue deduped on dedup_key=${opts.dedupKey} (queue ${queueName})`);
                return 0;
            }
            throw err;
        }
    }
    registerWorker(queueName, handler, concurrency = 3, leaseSeconds = DEFAULT_LEASE_SECONDS) {
        this.workers.set(queueName, {
            handler,
            concurrency,
            activeSlots: 0,
            leaseSeconds,
        });
        this.logger.log(`Worker registered for queue: ${queueName} (concurrency: ${concurrency}, lease: ${leaseSeconds}s)`);
    }
    async poll() {
        this.logger.verbose('polling jobs');
        for (const [queueName, worker] of this.workers.entries()) {
            const available = worker.concurrency - worker.activeSlots;
            if (available <= 0)
                continue;
            const now = new Date();
            const leaseExpiry = new Date(Date.now() + worker.leaseSeconds * 1000);
            const scanLimit = Math.min(available * SERIAL_SCAN_MULTIPLIER, SERIAL_SCAN_CAP);
            let candidates;
            try {
                candidates = await this.prisma.$queryRaw `
          SELECT j.id, j.serial_key FROM jobs j
          WHERE j.queue_name = ${queueName}
            AND j.status = 'pending'
            AND j.run_at <= ${now}
            AND (j.locked_until IS NULL OR j.locked_until < ${now})
            AND (j.serial_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM jobs p
              WHERE p.serial_key = j.serial_key
                AND p.status = 'processing'
                AND p.locked_until > ${now}))
          ORDER BY j.run_at
          LIMIT ${scanLimit}
          FOR UPDATE SKIP LOCKED
        `;
            }
            catch {
                continue;
            }
            if (!candidates.length)
                continue;
            const chosen = [];
            const batchSerials = new Set();
            for (const c of candidates) {
                if (chosen.length >= available)
                    break;
                if (c.serial_key !== null) {
                    if (batchSerials.has(c.serial_key))
                        continue;
                    batchSerials.add(c.serial_key);
                }
                chosen.push(c.id);
            }
            if (!chosen.length)
                continue;
            await this.prisma.job.updateMany({
                where: { id: { in: chosen } },
                data: {
                    status: 'processing',
                    locked_until: leaseExpiry,
                    locked_by: INSTANCE_ID,
                },
            });
            for (const id of chosen) {
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