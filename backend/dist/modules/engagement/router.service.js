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
var RouterService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RouterService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const work_item_service_1 = require("./work-item.service");
let RouterService = RouterService_1 = class RouterService {
    constructor(prisma, workItems) {
        this.prisma = prisma;
        this.workItems = workItems;
        this.logger = new common_1.Logger(RouterService_1.name);
    }
    typeForIntent(intent) {
        switch (intent) {
            case 'sales':
                return 'SALES';
            case 'order':
                return 'ORDER';
            case 'logistics':
                return 'TRACKING';
            case 'resolution':
                return 'DISPUTE';
            case 'general':
                return 'SUPPORT';
            default:
                return null;
        }
    }
    async route(params) {
        try {
            const type = this.typeForIntent(params.intent);
            if (!type)
                return null;
            let contactId = params.contactId ?? null;
            if (contactId == null) {
                const convo = await this.prisma.conversation.findFirst({
                    where: { id: params.conversationId, company_id: params.companyId },
                    select: { contact_id: true },
                });
                contactId = convo?.contact_id ?? null;
            }
            if (contactId == null)
                return null;
            const open = await this.workItems.listOpen(params.companyId, params.conversationId);
            let item = open.find((w) => w.type === type) ?? null;
            if (!item) {
                item = await this.workItems.open({
                    companyId: params.companyId,
                    conversationId: params.conversationId,
                    contactId,
                    type,
                    owner: 'AI',
                    actorType: 'CUSTOMER',
                });
            }
            const msg = await this.prisma.message.findFirst({
                where: { id: params.messageId, company_id: params.companyId },
                select: { id: true, work_item_id: true },
            });
            if (msg && msg.work_item_id == null) {
                const agg = await this.prisma.message.aggregate({
                    where: {
                        conversation_id: params.conversationId,
                        company_id: params.companyId,
                    },
                    _max: { seq: true },
                });
                await this.prisma.message.update({
                    where: { id: params.messageId },
                    data: { work_item_id: item.id, seq: (agg._max.seq ?? 0) + 1 },
                });
            }
            return item;
        }
        catch (e) {
            this.logger.debug(`route skipped (convo ${params.conversationId}): ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }
};
exports.RouterService = RouterService;
exports.RouterService = RouterService = RouterService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        work_item_service_1.WorkItemService])
], RouterService);
//# sourceMappingURL=router.service.js.map