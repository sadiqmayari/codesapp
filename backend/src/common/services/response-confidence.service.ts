import { Injectable } from '@nestjs/common';

/**
 * Specialist Confidence Framework (enterprise hardening — increment 10, spec #8).
 *
 * WHY: "never allow uncertain recommendations." Asking the LLM to self-report a
 * confidence is unreliable (a confidently-wrong model reports high confidence).
 * Instead we DERIVE confidence deterministically from observable signals of how
 * GROUNDED the reply is: did the specialist actually use its tools, did any tool
 * error, and does the reply hedge or quote a price/status it never looked up. The
 * orchestrator then deterministically decides: send, or hand off when too low.
 *
 * PURE: score()/decide() have no I/O — fully unit-testable. The caller supplies
 * the reply + the tools used (captured during the specialist run) + the intent.
 */

export interface ConfidenceInput {
  reply: string;
  /** Tool names the specialist invoked this turn. */
  toolsUsed: string[];
  /** Count of tool calls that errored this turn. */
  toolFailures: number;
  /** The routed specialist intent. */
  intent: string;
}

export interface ConfidenceResult {
  /** 0–100. */
  confidence: number;
  reasonCode: string;
}

export type ConfidenceDecision = 'send' | 'handoff';

/** Below this, hand off (clearly uncertain). */
export const CONFIDENCE_HANDOFF_BELOW = 50;
/** Below this, an uncertain *recommendation* is not sent (handed off instead). */
export const CONFIDENCE_CLARIFY_BELOW = 70;

const BASE = 75;

// Hedging / "I can't confirm" phrasing (English + Roman-Urdu).
const HEDGE_PHRASES = [
  "i'm not sure",
  'i am not sure',
  'not sure',
  'i think',
  'i believe',
  'maybe',
  'might be',
  'probably',
  "i can't confirm",
  'i cannot confirm',
  "can't confirm",
  'let me check',
  "i'll check",
  'i will check',
  'will get back',
  'get back to you',
  'pata nahi',
  'shayad',
  'mujhe nahi pata',
  'confirm kar ke bata',
  'check kar ke',
];

// Commerce intents where a price/status claim MUST be tool-grounded.
const RECOMMENDATION_INTENTS = new Set(['sales', 'order', 'logistics']);

function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

@Injectable()
export class ResponseConfidenceService {
  score(input: ConfidenceInput): ConfidenceResult {
    const reply = normalize(input.reply);
    const used = new Set(input.toolsUsed ?? []);
    let confidence = BASE;
    let reason = 'OK';

    if (!reply) {
      return { confidence: 0, reasonCode: 'EMPTY_REPLY' };
    }

    // A tool error means the data behind the reply is suspect.
    if (input.toolFailures > 0) {
      confidence -= 30;
      reason = 'TOOL_FAILURE';
    }

    // Hedging language → the model itself is unsure.
    if (HEDGE_PHRASES.some((p) => reply.includes(p))) {
      confidence -= 25;
      if (reason === 'OK') reason = 'HEDGING';
    }

    // Ungrounded price: a sales/order reply quoting a number without ever calling
    // search_products is a fabricated price risk.
    const mentionsNumber = /\b\d{2,7}\b/.test(reply);
    if (
      (input.intent === 'sales' || input.intent === 'order') &&
      mentionsNumber &&
      !used.has('search_products')
    ) {
      confidence -= 20;
      if (reason === 'OK') reason = 'UNGROUNDED_PRICE';
    }

    // Ungrounded status: a logistics reply that never looked the order up.
    if (
      input.intent === 'logistics' &&
      !used.has('get_order_status') &&
      !used.has('get_customer_history')
    ) {
      confidence -= 20;
      if (reason === 'OK') reason = 'NO_STATUS_TOOL';
    }

    // A grounded reply (used a tool, nothing failed) earns back confidence.
    if (
      used.size > 0 &&
      input.toolFailures === 0 &&
      RECOMMENDATION_INTENTS.has(input.intent)
    ) {
      confidence += 10;
    }

    confidence = Math.max(0, Math.min(100, confidence));
    return { confidence, reasonCode: reason };
  }

  /**
   * Deterministic action: hand off when clearly uncertain (< 50), or when an
   * uncertain RECOMMENDATION would otherwise be sent (< 70 on a commerce intent
   * where the reply is not already a clarifying question). Otherwise send.
   */
  decide(input: {
    confidence: number;
    intent: string;
    replyIsQuestion: boolean;
  }): ConfidenceDecision {
    if (input.confidence < CONFIDENCE_HANDOFF_BELOW) return 'handoff';
    if (
      input.confidence < CONFIDENCE_CLARIFY_BELOW &&
      RECOMMENDATION_INTENTS.has(input.intent) &&
      !input.replyIsQuestion
    ) {
      return 'handoff';
    }
    return 'send';
  }
}
