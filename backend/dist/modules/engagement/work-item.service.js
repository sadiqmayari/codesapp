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
var WorkItemService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkItemService = exports.InvalidTransitionError = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const event_store_service_1 = require("../../common/services/event-store.service");
const fsm_1 = require("./state/fsm");
const work_item_states_1 = require("./state/work-item-states");
function fsmFor(type) {
    return work_item_states_1.FSM_BY_TYPE[type];
}
class InvalidTransitionError extends Error {
    constructor(type, from, event) {
        super(`Invalid ${type} transition: ${from} --(${event})-->`);
        this.type = type;
        this.from = from;
        this.event = event;
        this.name = 'InvalidTransitionError';
    }
}
exports.InvalidTransitionError = InvalidTransitionError;
let WorkItemService = WorkItemService_1 = class WorkItemService {
    constructor(prisma, events) {
        this.prisma = prisma;
        this.events = events;
        this.logger = new common_1.Logger(WorkItemService_1.name);
    }
    async open(input) {
        const fsm = fsmFor(input.type);
        const item = await this.prisma.workItem.create({
            data: {
                company_id: input.companyId,
                conversation_id: input.conversationId,
                contact_id: input.contactId,
                type: input.type,
                state: fsm.initial,
                status: 'OPEN',
                owner: input.owner ?? 'AI',
                external_ref: input.externalRef ?? null,
                priority: input.priority ?? 5,
                last_activity_at: new Date(),
            },
        });
        await this.events.append({
            companyId: input.companyId,
            aggregateType: 'WORK_ITEM',
            aggregateId: item.id,
            type: `work_item.opened.${input.type.toLowerCase()}`,
            actorType: input.actorType ?? 'SYSTEM',
            actorId: input.actorId ?? null,
            payload: { type: input.type, state: fsm.initial },
            idempotencyKey: input.idempotencyKey ?? null,
        });
        return item;
    }
    async transition(input) {
        const item = await this.prisma.workItem.findFirst({
            where: { id: input.workItemId, company_id: input.companyId },
        });
        if (!item) {
            throw new InvalidTransitionError('?', 'missing', input.event);
        }
        const fsm = fsmFor(item.type);
        if (!fsm) {
            throw new InvalidTransitionError(item.type, item.state, input.event);
        }
        const to = (0, fsm_1.nextState)(fsm, item.state, input.event);
        if (!to) {
            throw new InvalidTransitionError(item.type, item.state, input.event);
        }
        const newStatus = (0, work_item_states_1.statusForState)(item.type, to);
        const terminal = (0, fsm_1.isTerminal)(fsm, to) || work_item_states_1.TERMINAL_STATUSES.has(newStatus);
        const updated = await this.prisma.workItem.update({
            where: { id: item.id },
            data: {
                state: to,
                status: newStatus,
                last_activity_at: new Date(),
                ...(terminal ? { closed_at: new Date() } : {}),
                ...(input.patch?.externalRef !== undefined
                    ? { external_ref: input.patch.externalRef }
                    : {}),
                ...(input.patch?.assignedUserId !== undefined
                    ? { assigned_user_id: input.patch.assignedUserId }
                    : {}),
                ...(input.patch?.owner !== undefined ? { owner: input.patch.owner } : {}),
                ...(input.patch?.expiresAt !== undefined
                    ? { expires_at: input.patch.expiresAt }
                    : {}),
                ...(input.patch?.priority !== undefined
                    ? { priority: input.patch.priority }
                    : {}),
            },
        });
        await this.events.append({
            companyId: input.companyId,
            aggregateType: 'WORK_ITEM',
            aggregateId: item.id,
            type: `work_item.${item.type.toLowerCase()}.${input.event}`,
            actorType: input.actorType,
            actorId: input.actorId ?? null,
            payload: { from: item.state, to, event: input.event, data: input.payload },
            idempotencyKey: input.idempotencyKey ?? null,
        });
        return updated;
    }
    async handoff(companyId, workItemId, reason, slaMs) {
        try {
            await this.prisma.workItem.updateMany({
                where: { id: workItemId, company_id: companyId },
                data: {
                    owner: 'HUMAN',
                    last_activity_at: new Date(),
                    ...(slaMs ? { expires_at: new Date(Date.now() + slaMs) } : {}),
                },
            });
            await this.events.append({
                companyId,
                aggregateType: 'WORK_ITEM',
                aggregateId: workItemId,
                type: 'work_item.handoff',
                actorType: 'AI',
                payload: { reason },
            });
        }
        catch (e) {
            this.logger.debug(`work-item handoff bookkeeping skipped (${workItemId}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    findOverdueHandoffs(limit = 100) {
        return this.prisma.workItem.findMany({
            where: {
                owner: 'HUMAN',
                status: 'OPEN',
                assigned_user_id: null,
                expires_at: { not: null, lt: new Date() },
            },
            orderBy: { expires_at: 'asc' },
            take: limit,
        });
    }
    async sweepOverdueHandoffs(slaMs, limit = 100) {
        const overdue = await this.findOverdueHandoffs(limit);
        const conversationIds = [];
        for (const item of overdue) {
            try {
                await this.events.append({
                    companyId: item.company_id,
                    aggregateType: 'WORK_ITEM',
                    aggregateId: item.id,
                    type: 'work_item.handoff.sla_breach',
                    actorType: 'SYSTEM',
                    payload: { type: item.type, conversationId: item.conversation_id },
                });
                await this.prisma.workItem.update({
                    where: { id: item.id },
                    data: { expires_at: new Date(Date.now() + slaMs) },
                });
                conversationIds.push(item.conversation_id);
            }
            catch {
            }
        }
        return { swept: conversationIds.length, conversationIds };
    }
    listOpen(companyId, conversationId) {
        return this.prisma.workItem.findMany({
            where: {
                company_id: companyId,
                conversation_id: conversationId,
                status: { in: ['OPEN', 'SNOOZED'] },
            },
            orderBy: { last_activity_at: 'desc' },
        });
    }
    get(companyId, id) {
        return this.prisma.workItem.findFirst({
            where: { id, company_id: companyId },
        });
    }
};
exports.WorkItemService = WorkItemService;
exports.WorkItemService = WorkItemService = WorkItemService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        event_store_service_1.EventStoreService])
], WorkItemService);
//# sourceMappingURL=work-item.service.js.map