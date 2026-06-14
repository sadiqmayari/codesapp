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
var ToldLedgerService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToldLedgerService = void 0;
const common_1 = require("@nestjs/common");
const crypto_1 = require("crypto");
const prisma_service_1 = require("../../prisma/prisma.service");
let ToldLedgerService = ToldLedgerService_1 = class ToldLedgerService {
    constructor(prisma) {
        this.prisma = prisma;
        this.logger = new common_1.Logger(ToldLedgerService_1.name);
    }
    hash(value) {
        return (0, crypto_1.createHash)('sha1').update(value).digest('hex');
    }
    async noteAndCheck(companyId, workItemId, factKind, value) {
        try {
            const fact_hash = this.hash(value);
            const existing = await this.prisma.toldLedger.findFirst({
                where: { work_item_id: workItemId, fact_kind: factKind, fact_hash },
                select: { id: true },
            });
            if (existing)
                return { alreadyTold: true };
            await this.prisma.toldLedger.create({
                data: {
                    company_id: companyId,
                    work_item_id: workItemId,
                    fact_kind: factKind,
                    fact_hash,
                },
            });
            return { alreadyTold: false };
        }
        catch (e) {
            this.logger.debug(`told-ledger noteAndCheck skipped (wi ${workItemId}): ${e instanceof Error ? e.message : String(e)}`);
            return { alreadyTold: false };
        }
    }
    async kindsTold(workItemId) {
        try {
            const rows = await this.prisma.toldLedger.findMany({
                where: { work_item_id: workItemId },
                select: { fact_kind: true },
                distinct: ['fact_kind'],
                take: 20,
            });
            return rows.map((r) => r.fact_kind);
        }
        catch {
            return [];
        }
    }
};
exports.ToldLedgerService = ToldLedgerService;
exports.ToldLedgerService = ToldLedgerService = ToldLedgerService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ToldLedgerService);
//# sourceMappingURL=told-ledger.service.js.map