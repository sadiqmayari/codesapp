import { FsmDef } from './fsm';

/**
 * Work-item types. A conversation may hold many OPEN items of these types at
 * once — that concurrency is what isolates disputes from sales and supports
 * multiple simultaneous orders.
 */
export type WorkItemType =
  | 'SALES'
  | 'ORDER'
  | 'TRACKING'
  | 'DISPUTE'
  | 'SUPPORT';

/**
 * Coarse lifecycle bucket (the `status` column), derived from the fine-grained
 * per-type `state`. Terminal = RESOLVED | CANCELLED | EXPIRED.
 */
export type WorkItemStatus =
  | 'OPEN'
  | 'SNOOZED'
  | 'RESOLVED'
  | 'CANCELLED'
  | 'EXPIRED';

export const TERMINAL_STATUSES: ReadonlySet<WorkItemStatus> = new Set([
  'RESOLVED',
  'CANCELLED',
  'EXPIRED',
]);

// ── Generic lane FSM (SALES / TRACKING / SUPPORT) ────────────────────────────
// Simple engagement skeleton; the awaiting_* states carry an SLA via expires_at.
export type GenericState =
  | 'ACTIVE'
  | 'AWAITING_CUSTOMER'
  | 'AWAITING_HUMAN'
  | 'AWAITING_EXTERNAL'
  | 'RESOLVED'
  | 'CANCELLED'
  | 'EXPIRED';

export const GENERIC_FSM: FsmDef<GenericState> = {
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

// ── ORDER FSM ────────────────────────────────────────────────────────────────
// Order creation is impossible unless validation passes: `submit` is only
// reachable from CONFIRMED, which is only reachable from VALID (validate()), and
// the actual Shopify create is the SUBMITTING->PLACED command. Ambiguous submit
// failure goes to RECONCILE (query Shopify before any retry → never duplicates).
export type OrderState =
  | 'DRAFT'
  | 'VALID'
  | 'CONFIRMED'
  | 'SUBMITTING'
  | 'RECONCILE'
  | 'PLACED'
  | 'UNFULFILLED'
  | 'FULFILLED'
  | 'DELIVERED'
  | 'AWAITING_PAYMENT'
  | 'PAYMENT_RECEIVED'
  | 'CANCELLED'
  | 'FAILED';

export const ORDER_FSM: FsmDef<OrderState> = {
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
        invalidate: 'DRAFT', // price drift / OOS discovered → back to drafting
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
        placed: 'PLACED', // found at Shopify
        reconcile_absent: 'CONFIRMED', // safe to retry submit
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
        payment_received: 'PAYMENT_RECEIVED', // slip arrived → human verifies
        cancel: 'CANCELLED',
      },
    },
    PAYMENT_RECEIVED: {
      // Verification is a human decision; on approval the order is confirmed.
      on: { confirm: 'CONFIRMED', cancel: 'CANCELLED' },
    },
    CANCELLED: { terminal: true, on: {} },
    FAILED: { terminal: true, on: {} },
  },
};

// ── TICKET (DISPUTE) FSM ─────────────────────────────────────────────────────
// Fully isolated lane. Every money decision (RESOLVED with refund/replace) is a
// human approval out of PROPOSED_RESOLUTION — the AI may gather + propose, never
// execute.
export type TicketState =
  | 'OPEN'
  | 'ACK'
  | 'INVESTIGATING'
  | 'AWAITING_EVIDENCE'
  | 'PROPOSED_RESOLUTION'
  | 'RESOLVED'
  | 'REJECTED';

export const TICKET_FSM: FsmDef<TicketState> = {
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

// ── type → FSM + initial state ───────────────────────────────────────────────
export const FSM_BY_TYPE = {
  SALES: GENERIC_FSM,
  TRACKING: GENERIC_FSM,
  SUPPORT: GENERIC_FSM,
  ORDER: ORDER_FSM,
  DISPUTE: TICKET_FSM,
} as const;

/**
 * Maps a fine-grained per-type state to its coarse lifecycle status. Anything
 * not explicitly terminal is OPEN (awaiting_* stays OPEN — it's still active
 * work, just blocked on someone).
 */
export function statusForState(type: WorkItemType, state: string): WorkItemStatus {
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
