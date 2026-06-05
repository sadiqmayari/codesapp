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
      const res = await client.audio.transcriptions.create({
        model: 'whisper-1',
        file: fs.createReadStream(diskPath),
        response_format: 'verbose_json',
      });
      // verbose_json includes `text` + `duration`.
      const text = (res as { text?: string }).text?.trim() ?? '';
      const durationSec = Number((res as { duration?: number }).duration ?? 0);
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
