import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import * as fs from 'fs';

/** Whisper price: $0.006 / minute == 100 micro-dollars / second. */
export const WHISPER_MICROS_PER_SEC = 100;

export interface TranscriptionResult {
  text: string;
  /** Audio length in seconds (from Whisper verbose response); 0 if unknown. */
  durationSec: number;
  /** Seconds billed across all passes (a re-pinned note costs two passes). */
  billedSec: number;
}

/**
 * Voice-note transcription via OpenAI Whisper. Used independently of the active
 * TEXT provider (Anthropic has no audio API in this abstraction), so it reads
 * OPENAI_API_KEY directly. Fail-safe: if the key is missing or anything throws,
 * returns null and the caller falls back to the "(sent audio)" placeholder —
 * voice transcription never breaks the AI flow.
 */
@Injectable()
export class AudioTranscriptionService {
  private readonly logger = new Logger(AudioTranscriptionService.name);
  private client: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return !!this.config.get<string>('OPENAI_API_KEY');
  }

  private getClient(): OpenAI | null {
    if (this.client) return this.client;
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) return null;
    this.client = new OpenAI({ apiKey });
    return this.client;
  }

  /**
   * Transcribe an audio file on disk. Returns null on any failure.
   *
   * `languageHint` (ISO-639-1, from the tenant's Agent Profile) handles
   * languages Whisper confuses: when the auto-detected language is a known
   * sibling of the hint (Urdu↔Hindi, Arabic dialects…), the note is
   * re-transcribed pinned to the hint. No hint = auto-detect only. Every pass
   * is counted in `billedSec` (the old code billed only the second pass).
   */
  async transcribe(
    diskPath: string,
    languageHint?: string | null,
  ): Promise<TranscriptionResult | null> {
    const client = this.getClient();
    if (!client) return null;
    try {
      if (!fs.existsSync(diskPath)) return null;
      const res = await client.audio.transcriptions.create({
        model: 'whisper-1',
        file: fs.createReadStream(diskPath),
        response_format: 'verbose_json',
      });
      let text = (res as { text?: string }).text?.trim() ?? '';
      const firstDur = Number((res as { duration?: number }).duration ?? 0);
      let durationSec = Number.isFinite(firstDur) ? firstDur : 0;
      let billedSec = durationSec;
      const detected = ((res as { language?: string }).language ?? '').toLowerCase();

      const hint = (languageHint ?? '').toLowerCase();
      const SIBLINGS: Record<string, RegExp> = {
        ur: /hindi|urdu|punjabi/,
        hi: /urdu|hindi/,
        ar: /arabic|persian|urdu/,
        bn: /bengali|hindi/,
      };
      const needsRepin =
        !!hint &&
        !!SIBLINGS[hint] &&
        SIBLINGS[hint].test(detected) &&
        !new RegExp(`^${hint}`).test(detected) &&
        // a genuine Hindi note for a Hindi tenant / Urdu note for Urdu stays
        !(hint === 'ur' && /urdu/.test(detected)) &&
        !(hint === 'hi' && /hindi/.test(detected));
      const devanagariForUrdu = hint === 'ur' && /[ऀ-ॿ]/.test(text);
      if (needsRepin || devanagariForUrdu) {
        try {
          const r2 = await client.audio.transcriptions.create({
            model: 'whisper-1',
            file: fs.createReadStream(diskPath),
            response_format: 'verbose_json',
            language: hint,
          });
          const t2 = (r2 as { text?: string }).text?.trim() ?? '';
          const d2 = Number((r2 as { duration?: number }).duration ?? 0);
          if (Number.isFinite(d2) && d2 > 0) billedSec += d2;
          if (t2) {
            text = t2;
            if (Number.isFinite(d2) && d2 > 0) durationSec = d2;
          }
        } catch (reErr) {
          this.logger.warn(
            `Re-transcription (${hint}) failed for ${diskPath}: ${
              reErr instanceof Error ? reErr.message : String(reErr)
            }`,
          );
        }
      }

      if (!text) return null;
      return { text, durationSec, billedSec };
    } catch (e) {
      this.logger.warn(
        `Whisper transcription failed for ${diskPath}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  }
}
