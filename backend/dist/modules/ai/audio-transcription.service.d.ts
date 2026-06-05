import { ConfigService } from '@nestjs/config';
export declare const WHISPER_MICROS_PER_SEC = 100;
export interface TranscriptionResult {
    text: string;
    durationSec: number;
}
export declare class AudioTranscriptionService {
    private readonly config;
    private readonly logger;
    private client;
    constructor(config: ConfigService);
    isConfigured(): boolean;
    private getClient;
    transcribe(diskPath: string): Promise<TranscriptionResult | null>;
}
