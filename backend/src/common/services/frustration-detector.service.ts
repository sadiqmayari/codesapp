import { Injectable } from '@nestjs/common';

/**
 * Customer Frustration Detection (enterprise hardening — increment 4, spec #9).
 *
 * WHY: a frustrated customer who keeps repeating themselves or shouting is the
 * clearest signal that the AI is failing them — letting it keep trying makes the
 * experience worse. This DETERMINISTIC detector scores frustration from the text
 * (no LLM, no sentiment model) so the orchestrator can hand off to a human with a
 * stable, auditable, testable rule rather than a probabilistic guess.
 *
 * PURE: evaluate() has no I/O. The caller supplies the latest message plus the
 * recent customer messages (for repeat detection) and compares the returned score
 * against a configured threshold. Signals + weights are deliberately conservative
 * so a single mildly-annoyed phrase does NOT escalate — escalation needs either an
 * explicit "you already told me / how many times" phrase or a combination of
 * shouting/exclamation/negativity, mirroring how a human would read the room.
 */

export interface FrustrationInput {
  /** The customer's latest inbound message text. */
  latest: string;
  /** Recent customer messages (chronological, may include `latest`). For repeats. */
  recent?: string[];
}

export interface FrustrationResult {
  /** 0–100. The caller escalates when this is >= the configured threshold. */
  score: number;
  /** Human-readable signal codes that contributed to the score. */
  signals: string[];
  reasonCode: 'CUSTOMER_FRUSTRATION' | 'NONE';
}

/** Default escalation threshold (operator-overridable via platform_settings). */
export const FRUSTRATION_DEFAULT_THRESHOLD = 60;

/** Neutral, empathetic handoff acknowledgement (deterministic, no LLM). */
export const FRUSTRATION_HANDOFF_ACK =
  'I’m really sorry for the trouble. Let me bring in a member of our team to ' +
  'help you with this right away.';

// Explicit "I've said this already / how many times" frustration — escalates alone.
const STRONG_PHRASES = [
  'already told you', 'i told you', 'already said', 'as i said',
  'you are not understanding', 'you re not understanding', 'not understanding',
  'how many times', 'third time', 'second time', 'again and again',
  'kitni baar', 'kitni dafa', 'baar baar', 'pehle bhi btaya', 'bata chuka',
  'bata chuki', 'tang aa gaya', 'tang a gaya', 'pareshan kar diya',
];

// Negative-sentiment words (each adds a smaller amount).
const NEGATIVE_WORDS = [
  'angry', 'terrible', 'awful', 'horrible', 'worst', 'useless', 'pathetic',
  'ridiculous', 'frustrated', 'frustrating', 'annoyed', 'annoying',
  'disappointed', 'disgusting', 'rubbish', 'nonsense', 'fed up',
  'bekar', 'faltu', 'ghatiya', 'bakwas', 'bekaar',
];

const W_STRONG = 60;
const W_REPEAT = 35;
const W_CAPS = 25;
const W_EXCLAIM = 20;
const W_NEGATIVE = 20;

function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(normalize(text).split(' ').filter((t) => t.length > 2));
}

/** Jaccard similarity of two token sets (0–1). */
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

@Injectable()
export class FrustrationDetectorService {
  evaluate(input: FrustrationInput): FrustrationResult {
    const raw = input.latest ?? '';
    const norm = normalize(raw);
    const signals: string[] = [];
    let score = 0;

    if (!norm) {
      return { score: 0, signals: [], reasonCode: 'NONE' };
    }

    // Explicit "I already told you / how many times" phrasing.
    if (STRONG_PHRASES.some((p) => norm.includes(p))) {
      score += W_STRONG;
      signals.push('EXPLICIT_FRUSTRATION_PHRASE');
    }

    // SHOUTING — mostly-uppercase message with enough letters to be intentional.
    const letters = raw.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 6) {
      const upper = raw.replace(/[^A-Z]/g, '').length;
      if (upper / letters.length >= 0.7) {
        score += W_CAPS;
        signals.push('ALL_CAPS');
      }
    }

    // Multiple exclamation marks ("!!", "!!!", or two separate "!").
    if ((raw.match(/!/g)?.length ?? 0) >= 2) {
      score += W_EXCLAIM;
      signals.push('MULTIPLE_EXCLAMATION');
    }

    // Negative-sentiment vocabulary.
    if (NEGATIVE_WORDS.some((w) => norm.includes(w))) {
      score += W_NEGATIVE;
      signals.push('NEGATIVE_SENTIMENT');
    }

    // Repeated question: the latest message closely matches an EARLIER one.
    // `recent` may include the current message as its last item; skip exactly one
    // self-occurrence so an earlier identical message still counts as a repeat.
    const cur = tokens(raw);
    let skippedSelf = false;
    let repeated = false;
    for (const m of input.recent ?? []) {
      if (!m) continue;
      if (!skippedSelf && m === raw) {
        skippedSelf = true; // this is the current message — don't compare to itself
        continue;
      }
      if (similarity(cur, tokens(m)) >= 0.8) {
        repeated = true;
        break;
      }
    }
    if (repeated) {
      score += W_REPEAT;
      signals.push('REPEATED_QUESTION');
    }

    score = Math.min(100, score);
    return {
      score,
      signals,
      reasonCode: signals.length ? 'CUSTOMER_FRUSTRATION' : 'NONE',
    };
  }
}
