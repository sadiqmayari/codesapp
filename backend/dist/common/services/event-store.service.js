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
var EventStoreService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventStoreService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let EventStoreService = EventStoreService_1 = class EventStoreService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(EventStoreService_1.name);
    }
    async append(e) {
        try {
            if (e.idempotencyKey) {
                const existing = await this.prisma.event.findFirst({
                    where: { company_id: e.companyId, idempotency_key: e.idempotencyKey },
                    select: { id: true },
                });
                if (existing)
                    return;
            }
            const aggregateId = typeof e.aggregateId === 'bigint' ? e.aggregateId : BigInt(e.aggregateId);
            const payloadJson = e.payload === undefined || e.payload === null
                ? null
                : JSON.stringify(e.payload);
            await this.prisma.$executeRaw `
        INSERT INTO events
          (company_id, aggregate_type, aggregate_id, seq, type, actor_type,
           actor_id, payload, idempotency_key, created_at)
        SELECT ${e.companyId}, ${e.aggregateType}, ${aggregateId},
               (SELECT COALESCE(MAX(t.seq), 0) + 1
                  FROM (SELECT seq FROM events
                         WHERE aggregate_type = ${e.aggregateType}
                           AND aggregate_id = ${aggregateId}) t),
               ${e.type}, ${e.actorType}, ${e.actorId ?? null},
               ${payloadJson}, ${e.idempotencyKey ?? null}, NOW(3)
      `;
        }
        catch (err) {
            this.logger.debug(`event append skipped (${e.aggregateType}#${String(e.aggregateId)} ${e.type}): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
};
exports.EventStoreService = EventStoreService;
exports.EventStoreService = EventStoreService = EventStoreService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], EventStoreService);
//# sourceMappingURL=event-store.service.js.map