import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from './llm.service';
import { AiMeteringService } from './ai-metering.service';
import { RewriteMode } from './dto/ai-actions.dto';
export interface DraftOrderResult {
    items: Array<{
        productQuery: string;
        quantity: number;
    }>;
    customer: {
        name: string | null;
        phone: string | null;
        address1: string | null;
        city: string | null;
        countryCode: string | null;
    };
    paymentMethod: 'cod' | 'prepaid' | null;
    note: string | null;
    confidence: 'high' | 'low';
    missing: string[];
}
export declare class AiService {
    private readonly prisma;
    private readonly llm;
    private readonly metering;
    private readonly inflight;
    constructor(prisma: PrismaService, llm: LlmService, metering: AiMeteringService);
    suggestReply(companyId: number, userId: number | null, conversationId: number, instruction?: string): Promise<{
        text: string;
    }>;
    summarize(companyId: number, userId: number | null, conversationId: number): Promise<{
        text: string;
    }>;
    draftOrder(companyId: number, userId: number | null, conversationId: number): Promise<DraftOrderResult>;
    rewrite(companyId: number, userId: number | null, text: string, mode: RewriteMode): Promise<{
        text: string;
    }>;
    translate(companyId: number, userId: number | null, text: string, targetLang: string): Promise<{
        text: string;
    }>;
    private run;
    autoReplyDecision(companyId: number, conversationId: number): Promise<{
        reply: string | null;
        handoff: boolean;
        reason: string;
    }>;
    private parseDecision;
    private parseDraftOrder;
    private acquire;
    private release;
    private languageRule;
    private loadCompany;
    private loadKnowledge;
    private baseSystem;
    private loadTranscript;
}
