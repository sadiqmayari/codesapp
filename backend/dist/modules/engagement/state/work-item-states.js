"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FSM_BY_TYPE = exports.TICKET_FSM = exports.ORDER_FSM = exports.GENERIC_FSM = exports.TERMINAL_STATUSES = void 0;
exports.statusForState = statusForState;
exports.TERMINAL_STATUSES = new Set([
    'RESOLVED',
    'CANCELLED',
    'EXPIRED',
]);
exports.GENERIC_FSM = {
    initial: 'ACTIVE',
    states: {
        ACTIVE: {
            on: {
                await_customer: 'AWAITING_CUSTOMER',
                await_human: 'AWAITING_HUMAN',
                await_external: 'AWAITING_EXTERNAL',
                resolve: 'RESOLVED',
                cancel: 'CANCELLED',
                expire: 'EXPIRED',
            },
        },
        AWAITING_CUSTOMER: {
            on: { activate: 'ACTIVE', resolve: 'RESOLVED', expire: 'EXPIRED' },
        },
        AWAITING_HUMAN: {
            on: { activate: 'ACTIVE', resolve: 'RESOLVED', cancel: 'CANCELLED' },
        },
        AWAITING_EXTERNAL: {
            on: { activate: 'ACTIVE', resolve: 'RESOLVED', expire: 'EXPIRED' },
        },
        RESOLVED: { terminal: true, on: {} },
        CANCELLED: { terminal: true, on: {} },
        EXPIRED: { terminal: true, on: {} },
    },
};
exports.ORDER_FSM = {
    initial: 'DRAFT',
    states: {
        DRAFT: {
            on: {
                validate: 'VALID',
                await_payment: 'AWAITING_PAYMENT',
                cancel: 'CANCELLED',
            },
        },
        VALID: {
            on: {
                confirm: 'CONFIRMED',
                invalidate: 'DRAFT',
                cancel: 'CANCELLED',
            },
        },
        CONFIRMED: {
            on: {
                submit: 'SUBMITTING',
                await_payment: 'AWAITING_PAYMENT',
                cancel: 'CANCELLED',
            },
        },
        SUBMITTING: {
            on: {
                placed: 'PLACED',
                submit_ambiguous: 'RECONCILE',
                fail: 'FAILED',
            },
        },
        RECONCILE: {
            on: {
                placed: 'PLACED',
                reconcile_absent: 'CONFIRMED',
                fail: 'FAILED',
            },
        },
        PLACED: {
            on: { fulfill: 'FULFILLED', unfulfilled: 'UNFULFILLED', cancel: 'CANCELLED' },
        },
        UNFULFILLED: {
            on: { fulfill: 'FULFILLED', cancel: 'CANCELLED' },
        },
        FULFILLED: {
            on: { deliver: 'DELIVERED', cancel: 'CANCELLED' },
        },
        DELIVERED: { terminal: true, on: {} },
        AWAITING_PAYMENT: {
            on: {
                payment_received: 'PAYMENT_RECEIVED',
                cancel: 'CANCELLED',
            },
        },
        PAYMENT_RECEIVED: {
            on: { confirm: 'CONFIRMED', cancel: 'CANCELLED' },
        },
        CANCELLED: { terminal: true, on: {} },
        FAILED: { terminal: true, on: {} },
    },
};
exports.TICKET_FSM = {
    initial: 'OPEN',
    states: {
        OPEN: { on: { ack: 'ACK', investigate: 'INVESTIGATING', reject: 'REJECTED' } },
        ACK: { on: { investigate: 'INVESTIGATING', reject: 'REJECTED' } },
        INVESTIGATING: {
            on: {
                request_evidence: 'AWAITING_EVIDENCE',
                propose: 'PROPOSED_RESOLUTION',
                reject: 'REJECTED',
            },
        },
        AWAITING_EVIDENCE: {
            on: { evidence_received: 'INVESTIGATING', reject: 'REJECTED' },
        },
        PROPOSED_RESOLUTION: {
            on: { resolve: 'RESOLVED', reject: 'REJECTED', investigate: 'INVESTIGATING' },
        },
        RESOLVED: { terminal: true, on: {} },
        REJECTED: { terminal: true, on: {} },
    },
};
exports.FSM_BY_TYPE = {
    SALES: exports.GENERIC_FSM,
    TRACKING: exports.GENERIC_FSM,
    SUPPORT: exports.GENERIC_FSM,
    ORDER: exports.ORDER_FSM,
    DISPUTE: exports.TICKET_FSM,
};
function statusForState(type, state) {
    switch (state) {
        case 'RESOLVED':
        case 'DELIVERED':
            return 'RESOLVED';
        case 'CANCELLED':
        case 'REJECTED':
            return 'CANCELLED';
        case 'EXPIRED':
        case 'FAILED':
            return 'EXPIRED';
        default:
            return 'OPEN';
    }
}
//# sourceMappingURL=work-item-states.js.map