import { ConfigService } from '@nestjs/config';
export declare class EmbeddingService {
    private readonly config;
    private readonly logger;
    private client;
    constructor(config: ConfigService);
    isConfigured(): boolean;
    private getClient;
    embed(texts: string[]): Promise<Float32Array[] | null>;
    embedOne(text: string): Promise<Float32Array | null>;
}
