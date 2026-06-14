import { FsmDef } from './fsm';
export type WorkItemType = 'SALES' | 'ORDER' | 'TRACKING' | 'DISPUTE' | 'SUPPORT';
export type WorkItemStatus = 'OPEN' | 'SNOOZED' | 'RESOLVED' | 'CANCELLED' | 'EXPIRED';
export declare const TERMINAL_STATUSES: ReadonlySet<WorkItemStatus>;
export type GenericState = 'ACTIVE' | 'AWAITING_CUSTOMER' | 'AWAITING_HUMAN' | 'AWAITING_EXTERNAL' | 'RESOLVED' | 'CANCELLED' | 'EXPIRED';
export declare const GENERIC_FSM: FsmDef<GenericState>;
export type OrderState = 'DRAFT' | 'VALID' | 'CONFIRMED' | 'SUBMITTING' | 'RECONCILE' | 'PLACED' | 'UNFULFILLED' | 'FULFILLED' | 'DELIVERED' | 'AWAITING_PAYMENT' | 'PAYMENT_RECEIVED' | 'CANCELLED' | 'FAILED';
export declare const ORDER_FSM: FsmDef<OrderState>;
export type TicketState = 'OPEN' | 'ACK' | 'INVESTIGATING' | 'AWAITING_EVIDENCE' | 'PROPOSED_RESOLUTION' | 'RESOLVED' | 'REJECTED';
export declare const TICKET_FSM: FsmDef<TicketState>;
export declare const FSM_BY_TYPE: {
    readonly SALES: FsmDef<GenericState>;
    readonly TRACKING: FsmDef<GenericState>;
    readonly SUPPORT: FsmDef<GenericState>;
    readonly ORDER: FsmDef<OrderState>;
    readonly DISPUTE: FsmDef<TicketState>;
};
export declare function statusForState(type: WorkItemType, state: string): WorkItemStatus;
