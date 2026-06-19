import { Injectable } from '@nestjs/common';

/**
 * Compliance Guard (enterprise hardening — increment 2).
 *
 * WHY THIS EXISTS
 * ---------------
 * CodesApp powers SUPPLEMENT businesses. Today the only protection against the
 * AI giving unsafe medical guidance is a *prompt instruction* ("never invent
 * dosage or medical advice"). Prompts are probabilistic — a small model can be
 * argued out of them, and they run only AFTER we've already paid for an LLM call
 * and committed to a generative answer. This service moves the first line of
 * medical-safety enforcement into DETERMINISTIC code that runs BEFORE triage and
 * BEFORE any LLM call: medically sensitive messages are intercepted and answered
 * with a fixed, safe, human-reviewed response instead of a generated one.
 *
 * DESIGN PRINCIPLES
 * -----------------
 * - PURE + DETERMINISTIC: `evaluate(text)` has no I/O, no LLM, no DB — same input
 *   always yields the same decision, so it is exhaustively unit-testable and
 *   auditable. Feature-flag gating, event logging and message sending are the
 *   CALLER's responsibility (the ai-agent orchestrator), keeping this isolated.
 * - SAFETY PRECEDENCE: HIGH (sensitive populations / crises) wins over MEDIUM
 *   (chronic condition / medication) wins over LOW (benign info).
 * - PRODUCT-AWARE FALSE-POSITIVE CONTROL: this is a store that SELLS children's
 *   vitamins, prenatal/condition-targeted products, etc. So population words that
 *   are ALSO product categories ("kids", "child", "baby") must NOT trigger a
 *   handoff on their own — they require an advice-seeking phrase ("safe for my
 *   child", "give it to my baby"). Unambiguous crisis terms (cancer, chemo,
 *   surgery, pregnant) DO trigger on their own. This keeps normal sales flows
 *   intact while still catching genuine "can my pregnant wife take this?" cases.
 * - CONFIGURABLE + EXTENSIBLE: keyword/phrase sets are exported constants;
 *   adding a term is a one-line change. Matching is case-insensitive, diacritic-
 *   insensitive, phrase-aware, and includes practical Roman-Urdu variants.
 *
 * NOTE ON THE SPEC'S "prescription interactions": the concrete example
 * ("Can I take this while using metformin?") is classified MEDIUM, so medication
 * mentions are treated as MEDIUM (informational-with-consult). Only sensitive
 * POPULATIONS and CRISES are HIGH. This honours the explicit examples over the
 * abstract bullet and avoids over-escalating routine "can I take X with Y" asks.
 */

export type ComplianceAction = 'PROCEED' | 'SAFE_RESPONSE' | 'HANDOFF';
export type ComplianceRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ComplianceDecision {
  action: ComplianceAction;
  riskLevel: ComplianceRiskLevel;
  matchedKeywords: string[];
  response?: string;
  reasonCode: string;
}

// ── Deterministic responses (fixed, never generated) ───────────────────────

/** MEDIUM: chronic condition / medication present — inform + consult, no handoff. */
export const COMPLIANCE_MEDIUM_RESPONSE =
  'Thanks for sharing that. Whether a supplement is suitable can depend on your ' +
  'individual health circumstances, so we’d recommend checking with your doctor ' +
  'or a qualified healthcare professional before starting it. I’m happy to share ' +
  'the product’s ingredients and label details so you can discuss them with your ' +
  'physician.';

/** HIGH: sensitive population / medical crisis — verbatim per spec. */
export const COMPLIANCE_HIGH_RESPONSE =
  'Thank you for reaching out. Because this question involves a medically ' +
  'sensitive situation, one of our team members will review it and assist you ' +
  'shortly.';

// ── Configurable keyword / phrase sets ─────────────────────────────────────
// Lowercase. Multi-word entries are matched as phrases (flexible whitespace).
// Diacritics are stripped before matching, so Urdu transliterations need only
// their plain ASCII form here.

/** MEDIUM — chronic disease / condition mentions (English + Roman-Urdu). */
export const DISEASE_KEYWORDS: string[] = [
  'diabetes', 'diabetic', 'ziabetes', 'shugar', 'sugar ki bimari', 'sugar ka marz',
  'sugar ke mareez', 'thyroid', 'hypothyroid', 'hyperthyroid', 'goiter',
  'hypertension', 'high blood pressure', 'low blood pressure', 'blood pressure', 'bp',
  'heart disease', 'heart condition', 'cardiac', 'dil ka marz', 'dil ki bimari',
  'pcos', 'pcod', 'cholesterol', 'asthma', 'arthritis', 'gathiya',
  'kidney disease', 'kidney problem', 'gurda', 'renal',
  'liver disease', 'liver problem', 'fatty liver', 'jigar',
  'epilepsy', 'migraine', 'ulcer', 'hepatitis',
];

/** MEDIUM — medication mentions (drug names + classes). */
export const MEDICATION_KEYWORDS: string[] = [
  'metformin', 'insulin', 'warfarin', 'aspirin', 'blood thinner', 'blood thinners',
  'anticoagulant', 'antibiotic', 'antibiotics', 'steroid', 'steroids',
  'statin', 'statins', 'thyroxine', 'levothyroxine', 'eltroxin',
  'antidepressant', 'antidepressants', 'beta blocker', 'chemotherapy drug',
];

/**
 * HIGH — sensitive populations / medical crises that warrant a human.
 * These are unambiguous enough to trigger on their own (a customer does not
 * browse for "cancer" or "chemotherapy" the way they browse for "kids vitamins").
 */
export const HIGH_RISK_KEYWORDS: string[] = [
  // Pregnancy / breastfeeding (Roman-Urdu variants too).
  'pregnant', 'pregnancy', 'breastfeeding', 'breast feeding', 'nursing',
  'lactating', 'hamla', 'haamla', 'umeed se', 'doodh pila', 'doodh pilati',
  'doodh pilana', 'newborn',
  // Cancer / oncology.
  'cancer', 'chemotherapy', 'chemo', 'tumor', 'tumour', 'oncology', 'radiation therapy',
  // Surgery / hospitalisation.
  'surgery', 'operation', 'post surgery', 'pre surgery', 'hospitalized',
  'hospitalised', 'hospital', 'admitted', 'icu', 'dialysis', 'transplant',
  // Acute / emergency symptoms.
  'emergency', 'seizure', 'fit aana', 'daura', 'unconscious', 'fainting',
  'chest pain', 'heart attack', 'stroke', 'overdose', 'bleeding heavily',
];

/**
 * HIGH — children/infant CONTEXT phrases. Bare "kid/child/baby" is intentionally
 * NOT here (it is a product category for this store). These phrases indicate the
 * customer is asking to ADMINISTER a supplement to a child → human review.
 */
export const CHILD_CONTEXT_KEYWORDS: string[] = [
  'for my child', 'for my baby', 'for my kid', 'for my infant', 'for my toddler',
  'my child has', 'my baby has', 'my kid has', 'safe for my child',
  'safe for my baby', 'safe for children', 'can my child', 'can my baby',
  'can my kid', 'give it to my child', 'give it to my baby', 'give to my child',
  'mere bachay ko', 'mere bache ko', 'bachi ko', 'bachay ko de', 'bache ko de',
  'infant', 'toddler',
];

interface CompiledTerm {
  term: string;
  re: RegExp;
}

/** Compile a keyword set into anchored, phrase-aware, case-insensitive regexes. */
function compile(terms: string[]): CompiledTerm[] {
  return terms.map((t) => {
    const escaped = t
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape regex metachars
      .replace(/\s+/g, '\\s+'); // phrase: allow flexible whitespace
    return { term: t, re: new RegExp(`(?:^|\\W)${escaped}(?:\\W|$)`, 'i') };
  });
}

/** Normalize once: lowercase, strip diacritics, punctuation → space, collapse. */
function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation → space (keeps phrase boundaries)
    .replace(/\s+/g, ' ')
    .trim();
}

@Injectable()
export class ComplianceGuardService {
  // Compiled once at construction — evaluate() stays allocation-light + fast.
  private readonly disease = compile(DISEASE_KEYWORDS);
  private readonly medication = compile(MEDICATION_KEYWORDS);
  private readonly highRisk = compile([
    ...HIGH_RISK_KEYWORDS,
    ...CHILD_CONTEXT_KEYWORDS,
  ]);

  /**
   * Deterministically classify a customer message's medical-compliance risk and
   * decide the action. No LLM, no I/O. HIGH precedence over MEDIUM over LOW.
   */
  evaluate(rawText: string): ComplianceDecision {
    const text = normalize(rawText);
    if (!text) {
      return {
        action: 'PROCEED',
        riskLevel: 'LOW',
        matchedKeywords: [],
        reasonCode: 'NONE',
      };
    }

    // HIGH first (safety precedence).
    const high = this.match(this.highRisk, text);
    if (high.length) {
      return {
        action: 'HANDOFF',
        riskLevel: 'HIGH',
        matchedKeywords: high,
        response: COMPLIANCE_HIGH_RESPONSE,
        reasonCode: 'HIGH_RISK_SITUATION',
      };
    }

    // MEDIUM — chronic disease takes reason-code priority over medication.
    const disease = this.match(this.disease, text);
    const medication = this.match(this.medication, text);
    if (disease.length || medication.length) {
      return {
        action: 'SAFE_RESPONSE',
        riskLevel: 'MEDIUM',
        matchedKeywords: [...disease, ...medication],
        response: COMPLIANCE_MEDIUM_RESPONSE,
        reasonCode: disease.length ? 'CHRONIC_CONDITION' : 'MEDICATION_MENTION',
      };
    }

    // LOW — benign informational; proceed with the existing pipeline.
    return {
      action: 'PROCEED',
      riskLevel: 'LOW',
      matchedKeywords: [],
      reasonCode: 'NONE',
    };
  }

  /** Collect the canonical terms whose compiled regex matches the text (deduped). */
  private match(set: CompiledTerm[], text: string): string[] {
    const hits: string[] = [];
    for (const { term, re } of set) {
      if (re.test(text)) hits.push(term);
    }
    return Array.from(new Set(hits));
  }
}
