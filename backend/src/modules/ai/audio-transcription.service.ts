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

  /** Transcribe an audio file on disk. Returns null on any failure. */
  async transcribe(diskPath: string): Promise<TranscriptionResult | null> {
    const client = this.getClient();
    if (!client) return null;
    try {
      if (!fs.existsSync(diskPath)) return null;
      // First pass: auto-detect language (so genuine English notes stay English).
      const res = await client.audio.transcriptions.create({
        model: 'whisper-1',
        file: fs.createReadStream(diskPath),
        response_format: 'verbose_json',
      });
      // verbose_json includes `text` + `duration` + `language` (full name).
      let text = (res as { text?: string }).text?.trim() ?? '';
      let durationSec = Number((res as { duration?: number }).duration ?? 0);
      const detected = (res as { language?: string }).language ?? '';

      // Urdu and Hindi are the same spoken language (Hindustani); Whisper often
      // mislabels Pakistani/Urdu audio as Hindi and emits Devanagari — which the
      // tenant does NOT want (English / Roman-Urdu / Urdu ONLY, never Hindi). If
      // the first pass came back as Hindi or contains any Devanagari glyphs,
      // re-transcribe with the language pinned to Urdu so it renders in Urdu
      // script instead. English/other notes are left untouched.
      if (/hindi/i.test(detected) || /[ऀ-ॿ]/.test(text)) {
        try {
          const urRes = await client.audio.transcriptions.create({
            model: 'whisper-1',
            file: fs.createReadStream(diskPath),
            response_format: 'verbose_json',
            language: 'ur',
          });
          const urText = (urRes as { text?: string }).text?.trim() ?? '';
          if (urText) {
            text = urText;
            const urDur = Number((urRes as { duration?: number }).duration ?? 0);
            if (Number.isFinite(urDur) && urDur > 0) durationSec = urDur;
          }
        } catch (reErr) {
          // Keep the first-pass text on a re-run failure rather than losing the
          // transcription entirely.
          this.logger.warn(
            `Urdu re-transcription failed for ${diskPath}: ${
              reErr instanceof Error ? reErr.message : String(reErr)
            }`,
          );
        }
      }

      if (!text) return null;
      return {
        text,
        durationSec: Number.isFinite(durationSec) ? durationSec : 0,
      };
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
