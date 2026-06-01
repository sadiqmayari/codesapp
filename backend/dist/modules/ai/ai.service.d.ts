import { PrismaService } from '../../prisma/prisma.service';
import { AnthropicClientService } from './anthropic-client.service';
import { AiMeteringService } from './ai-metering.service';
import { RewriteMode } from './dto/ai-actions.dto';
export declare class AiService {
    private readonly prisma;
    private readonly anthropic;
    private readonly metering;
    private readonly inflight;
    constructor(prisma: PrismaService, anthropic: AnthropicClientService, metering: AiMeteringService);
    suggestReply(companyId: number, userId: number | null, conversationId: number, instruction?: string): Promise<{
        text: string;
    }>;
    summarize(companyId: number, userId: number | null, conversationId: number): Promise<{
        text: string;
    }>;
    rewrite(companyId: number, userId: number | null, text: string, mode: RewriteMode): Promise<{
        text: string;
    }>;
    translate(companyId: number, userId: number | null, text: string, targetLang: string): Promise<{
        text: string;
    }>;
    private run;
    private acquire;
    private release;
    private loadCompany;
    private loadKnowledge;
    private baseSystem;
    private loadTranscript;
}
