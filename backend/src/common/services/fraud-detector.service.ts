import { Injectable } from '@nestjs/common';

/**
 * Fraud / Risk Detection (enterprise hardening — increment 4, spec #6).
 *
 * WHY: the highest-value fraud vector on a WhatsApp COD store is SOCIAL
 * ENGINEERING of the agent — a customer (or an impostor on a hijacked number)
 * trying to redirect payment to another account, or a pattern of changed
 * phones/addresses and failed orders. This DETERMINISTIC scorer turns those into
 * a stable riskScore + factors so the orchestrator can force human review before
 * anything costly happens, rather than relying on the model to "notice".
 *
 * PURE: evaluate() has no I/O. Text-derived signals (payment redirection) are
 * computed from the message; HISTORY-derived signals (repeated phone/address
 * changes, failed orders, excessive modifications) are passed IN as counters by
 * the caller, so the scorer stays fully unit-testable and the (potentially
 * expensive) data gathering is the integration layer's concern. Unsupplied
 * counters default to 0 — i.e. text-only scoring still works on day one, and the
 * historical signals light up as the caller wires each data source.
 */

export interface FraudHistory {
  /** Distinct phone numbers this customer has used recently. */
  phoneChanges?: number;
  /** Distinct delivery addresses used recently. */
  addressChanges?: number;
  /** Recent failed / cancelled / returned orders. */
  failedOrders?: number;
  /** Order/cart modifications in this conversation. */
  modifications?: number;
}

export interface FraudInput {
  /** The customer's latest inbound message text. */
  text: string;
  history?: FraudHistory;
}

export interface FraudResult {
  /** 0–100. */
  riskScore: number;
  /** Contributing risk-factor codes. */
  riskFactors: string[];
  /** True when riskScore >= the (configured) threshold passed to evaluate(). */
  requiresHumanReview: boolean;
}

/** Default risk threshold (operator-overridable via platform_settings). */
export const FRAUD_DEFAULT_THRESHOLD = 60;

/** Neutral handoff ack — must NOT tip off a potential fraudster. */
export const FRAUD_HANDOFF_ACK =
  'Thanks for the details. Let me connect you with a member of our team who ' +
  'will assist you further.';

// Phrases that indicate an attempt to redirect payment off the official channel.
const PAYMENT_REDIRECTION_PHRASES = [
  'send the money to', 'send money to', 'transfer to this account',
  'transfer to my', 'pay to this number', 'pay to this account',
  'different account', 'another account', 'other account',
  'my personal account', 'send payment to', 'pay me directly',
  'pay directly to', 'account number is', 'change the account',
  'use this account', 'this easypaisa', 'this jazzcash', 'my easypaisa',
  'my jazzcash', 'kisi aur account', 'doosre account', 'dusre account',
  'mere account', 'is account par', 'is number par bhej', 'directly mujhe',
];

// Weights.
const W_PAYMENT_REDIRECTION = 60; // strong — escalates on its own
const W_PHONE_CHANGE = 25;
const W_ADDRESS_CHANGE = 25;
const W_FAILED_ORDERS = 35;
const W_MODIFICATIONS = 25;

// Thresholds for the history counters.
const PHONE_CHANGE_MIN = 2;
const ADDRESS_CHANGE_MIN = 2;
const FAILED_ORDERS_MIN = 2;
const MODIFICATIONS_MIN = 4;

function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

@Injectable()
export class FraudDetectorService {
  evaluate(
    input: FraudInput,
    threshold: number = FRAUD_DEFAULT_THRESHOLD,
  ): FraudResult {
    const norm = normalize(input.text);
    const factors: string[] = [];
    let score = 0;

    if (norm && PAYMENT_REDIRECTION_PHRASES.some((p) => norm.includes(p))) {
      score += W_PAYMENT_REDIRECTION;
      factors.push('PAYMENT_REDIRECTION');
    }

    const h = input.history ?? {};
    if ((h.phoneChanges ?? 0) >= PHONE_CHANGE_MIN) {
      score += W_PHONE_CHANGE;
      factors.push('REPEATED_PHONE_CHANGE');
    }
    if ((h.addressChanges ?? 0) >= ADDRESS_CHANGE_MIN) {
      score += W_ADDRESS_CHANGE;
      factors.push('REPEATED_ADDRESS_CHANGE');
    }
    if ((h.failedOrders ?? 0) >= FAILED_ORDERS_MIN) {
      score += W_FAILED_ORDERS;
      factors.push('MULTIPLE_FAILED_ORDERS');
    }
    if ((h.modifications ?? 0) >= MODIFICATIONS_MIN) {
      score += W_MODIFICATIONS;
      factors.push('EXCESSIVE_MODIFICATIONS');
    }

    const riskScore = Math.min(100, score);
    return {
      riskScore,
      riskFactors: factors,
      requiresHumanReview: riskScore >= threshold,
    };
  }
}
