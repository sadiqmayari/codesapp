import { Injectable } from '@nestjs/common';

/**
 * Multimodal Image Routing (enterprise hardening — increment 7, spec #11).
 *
 * WHY: an inbound image is high-stakes — a PAYMENT SLIP must reach a human (never
 * be "confirmed" by the AI), a PRESCRIPTION must never draw medical advice, a
 * DAMAGE photo belongs in resolution, a PRODUCT photo in sales. Letting the LLM
 * decide what an image "is" is non-deterministic and unsafe. This classifier runs
 * BEFORE the LLM and routes deterministically from signals we CAN read without a
 * vision model: the conversation state (awaiting a payment slip), the message
 * caption, the recent customer text, and the media type. (Pixel-level content
 * classification would need vision; the highest-risk routes — slip/prescription —
 * are reliably driven by context + caption, which is what this layer enforces.)
 *
 * PURE + deterministic: classify() has no I/O. The caller gates it behind a flag
 * and acts on the type, so this stays isolated + exhaustively testable.
 */

export type ImageType =
  | 'PAYMENT_SLIP'
  | 'PRESCRIPTION'
  | 'DAMAGE_PHOTO'
  | 'PRODUCT_IMAGE'
  | 'OTHER';

export interface ImageRouteInput {
  /** WhatsApp message type of the latest inbound message. */
  mediaType?: string | null;
  /** The image/document caption, if any. */
  caption?: string | null;
  /** Recent customer text (context around the image). */
  recentText?: string | null;
  /** Conversation is awaiting a prepaid payment slip. */
  awaitingPayment?: boolean;
}

/** PAYMENT_SLIP: always human verification (never AI-confirmed). */
export const IMAGE_PAYMENT_SLIP_ACK =
  'Thank you for sharing the payment proof. Our team will verify it and confirm ' +
  'your order shortly.';

/** PRESCRIPTION: never generate medical advice. */
export const IMAGE_PRESCRIPTION_RESPONSE =
  'Thanks for sharing this. We’re not able to review prescriptions or give ' +
  'medical advice over chat — please follow your doctor’s guidance or consult a ' +
  'healthcare professional. I’m happy to help with product details, prices, and ' +
  'orders, and a team member can assist further.';

const PAYMENT_KEYWORDS = [
  'payment', 'paid', 'pay kar', 'pay kr', 'slip', 'receipt', 'reciept',
  'transaction', 'trx', 'transfer', 'deposit', 'easypaisa', 'jazzcash',
  'bank transfer', 'screenshot', 'raseed', 'paise bhej', 'paise bhej',
  'payment kar di', 'paid kar di', 'account me daal', 'account mein daal',
  'proof of payment', 'payment proof',
];
const PRESCRIPTION_KEYWORDS = [
  'prescription', 'prescribed', ' rx ', 'doctor note', 'doctor s note',
  'physician', 'nuskha', 'parchi', 'medical report', 'lab report',
  'doctor ne likha', 'doctor likha',
];
const DAMAGE_KEYWORDS = [
  'damaged', 'damage', 'broken', 'leaked', 'leaking', 'defective', 'torn',
  'cracked', 'expired', 'wrong item', 'wrong product', 'kharab', 'toota',
  'tuta', 'phata', 'leak ho', 'galat product', 'ghalat product', 'missing item',
];

function normalize(text: string): string {
  return ` ${(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `; // pad so " rx " word-boundary phrases match at edges
}

@Injectable()
export class ImageRouterService {
  /**
   * Classify an inbound image/document deterministically. Precedence is by RISK:
   * an awaiting-payment context or a payment caption is PAYMENT_SLIP; then
   * prescription; then damage; a bare image with no signal defaults to
   * PRODUCT_IMAGE; anything else is OTHER.
   */
  classify(input: ImageRouteInput): ImageType {
    const media = (input.mediaType ?? '').toLowerCase();
    if (media !== 'image' && media !== 'document') return 'OTHER';

    const text = normalize(`${input.caption ?? ''} ${input.recentText ?? ''}`);

    if (input.awaitingPayment) return 'PAYMENT_SLIP';
    if (PAYMENT_KEYWORDS.some((k) => text.includes(k))) return 'PAYMENT_SLIP';
    if (PRESCRIPTION_KEYWORDS.some((k) => text.includes(k))) return 'PRESCRIPTION';
    if (DAMAGE_KEYWORDS.some((k) => text.includes(k))) return 'DAMAGE_PHOTO';
    if (media === 'image') return 'PRODUCT_IMAGE';
    return 'OTHER';
  }
}
