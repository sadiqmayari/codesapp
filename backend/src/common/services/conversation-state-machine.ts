import { Injectable } from '@nestjs/common';

/**
 * Conversation State Machine (enterprise hardening — increment 9 / spec #1).
 *
 * WHY: today conversation/commerce state lives in a pile of nullable `ai_*` flags
 * written ad-hoc from many call sites; the LLM effectively drives workflow. This
 * is the DETERMINISTIC backend state machine: an explicit, validated transition
 * table that the backend (never the model) advances. The model may READ the state
 * as context; only business logic writes it, and an invalid transition is rejected.
 *
 * PURE: this class has no I/O — it only knows the states + the legal transitions.
 * Persistence + event logging live in ConversationStateService. It ships first in
 * SHADOW mode (recorded + validated alongside the existing flow, changing nothing)
 * so the transition table can be proven against real traffic before it becomes
 * authoritative.
 *
 * ── States ──────────────────────────────────────────────────────────────
 *   BROWSING            pre-purchase: products/price/availability questions
 *   CART_BUILDING       choosing items / quantities to buy
 *   COLLECTING_DETAILS  gathering name/phone/address/payment
 *   AWAITING_CONFIRMATION order summarised, waiting for the customer's yes
 *   PAYMENT_PENDING     prepaid: bank details shared, awaiting the slip
 *   ORDER_CREATED       a real order exists
 *   ORDER_STATUS        asking about an EXISTING order (tracking/where is it)
 *   TICKET_OPEN         a dispute/complaint is open
 *   HUMAN_HANDOFF       a human owns the chat
 *   CLOSED              the customer signed off
 *
 * ── Transitions (documented) ────────────────────────────────────────────
 *   Forward commerce funnel:
 *     BROWSING            → CART_BUILDING
 *     CART_BUILDING       → COLLECTING_DETAILS | AWAITING_CONFIRMATION | PAYMENT_PENDING
 *     COLLECTING_DETAILS  → CART_BUILDING | AWAITING_CONFIRMATION | PAYMENT_PENDING
 *     AWAITING_CONFIRMATION → CART_BUILDING | COLLECTING_DETAILS | PAYMENT_PENDING | ORDER_CREATED
 *     (PAYMENT_PENDING is reachable directly from a built cart for a PREPAID order,
 *      where bank details + await-slip follow the cart without a separate confirm.)
 *     PAYMENT_PENDING     → AWAITING_CONFIRMATION | ORDER_CREATED
 *     ORDER_CREATED       → CART_BUILDING (reorder)
 *   Pivots allowed from ANY state (a customer can do these at any time):
 *     → BROWSING, ORDER_STATUS, TICKET_OPEN, HUMAN_HANDOFF, CLOSED
 *   Fresh journey from a terminal state:
 *     {ORDER_CREATED, ORDER_STATUS, TICKET_OPEN, HUMAN_HANDOFF, CLOSED} → {BROWSING, CART_BUILDING}
 *   A self-transition (state unchanged) is always valid (idempotent).
 */

export type ConversationState =
  | 'BROWSING'
  | 'CART_BUILDING'
  | 'COLLECTING_DETAILS'
  | 'AWAITING_CONFIRMATION'
  | 'PAYMENT_PENDING'
  | 'ORDER_CREATED'
  | 'ORDER_STATUS'
  | 'TICKET_OPEN'
  | 'HUMAN_HANDOFF'
  | 'CLOSED';

export const CONVERSATION_STATES: ConversationState[] = [
  'BROWSING',
  'CART_BUILDING',
  'COLLECTING_DETAILS',
  'AWAITING_CONFIRMATION',
  'PAYMENT_PENDING',
  'ORDER_CREATED',
  'ORDER_STATUS',
  'TICKET_OPEN',
  'HUMAN_HANDOFF',
  'CLOSED',
];

/** Targets a customer can reach from ANY state (pivots). */
const GLOBAL_TARGETS = new Set<ConversationState>([
  'BROWSING',
  'ORDER_STATUS',
  'TICKET_OPEN',
  'HUMAN_HANDOFF',
  'CLOSED',
]);

/** Terminal-ish states from which a brand-new journey may start. */
const TERMINAL = new Set<ConversationState>([
  'ORDER_CREATED',
  'ORDER_STATUS',
  'TICKET_OPEN',
  'HUMAN_HANDOFF',
  'CLOSED',
]);

/** States that begin a fresh commerce journey. */
const START = new Set<ConversationState>(['BROWSING', 'CART_BUILDING']);

/** Forward funnel adjacency (pivots/globals handled separately). */
const FORWARD: Record<ConversationState, ConversationState[]> = {
  BROWSING: ['CART_BUILDING'],
  CART_BUILDING: ['COLLECTING_DETAILS', 'AWAITING_CONFIRMATION', 'PAYMENT_PENDING'],
  COLLECTING_DETAILS: ['CART_BUILDING', 'AWAITING_CONFIRMATION', 'PAYMENT_PENDING'],
  AWAITING_CONFIRMATION: [
    'CART_BUILDING',
    'COLLECTING_DETAILS',
    'PAYMENT_PENDING',
    'ORDER_CREATED',
  ],
  PAYMENT_PENDING: ['AWAITING_CONFIRMATION', 'ORDER_CREATED'],
  ORDER_CREATED: ['CART_BUILDING'],
  ORDER_STATUS: [],
  TICKET_OPEN: [],
  HUMAN_HANDOFF: [],
  CLOSED: [],
};

@Injectable()
export class ConversationStateMachine {
  /** Whether `to` is a valid next state from `from`. */
  canTransition(from: ConversationState, to: ConversationState): boolean {
    if (from === to) return true; // idempotent self-transition
    if (GLOBAL_TARGETS.has(to)) return true; // pivot allowed anytime
    if (TERMINAL.has(from) && START.has(to)) return true; // fresh journey
    return FORWARD[from].includes(to);
  }

  /** Validate or throw-free check used by the service. */
  validate(
    from: ConversationState,
    to: ConversationState,
  ): { ok: boolean; reason?: string } {
    if (this.canTransition(from, to)) return { ok: true };
    return { ok: false, reason: `illegal transition ${from} → ${to}` };
  }

  /** Whether a string is a known state (defensive parsing of persisted values). */
  isState(v: unknown): v is ConversationState {
    return (
      typeof v === 'string' &&
      (CONVERSATION_STATES as string[]).includes(v)
    );
  }

  /**
   * Map a deterministic routing signal (triage intent + lifecycle events) to the
   * canonical state. The orchestrator calls this; the model never does.
   */
  fromSignal(
    signal:
      | 'sales'
      | 'order'
      | 'logistics'
      | 'resolution'
      | 'general'
      | 'closing'
      | 'escalate'
      | 'order_created'
      | 'awaiting_confirmation'
      | 'payment_pending'
      | 'handoff'
      | 'ticket_open',
  ): ConversationState {
    switch (signal) {
      case 'sales':
      case 'general':
        return 'BROWSING';
      case 'order':
        return 'CART_BUILDING';
      case 'awaiting_confirmation':
        return 'AWAITING_CONFIRMATION';
      case 'payment_pending':
        return 'PAYMENT_PENDING';
      case 'order_created':
        return 'ORDER_CREATED';
      case 'logistics':
        return 'ORDER_STATUS';
      case 'resolution':
      case 'ticket_open':
        return 'TICKET_OPEN';
      case 'closing':
        return 'CLOSED';
      case 'escalate':
      case 'handoff':
        return 'HUMAN_HANDOFF';
    }
  }
}
