import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingService } from '../../common/services/platform-setting.service';
import { LlmService } from './llm.service';
import { AiMeteringService } from './ai-metering.service';
import { AiRagService } from './ai-rag.service';
import { AudioTranscriptionService } from './audio-transcription.service';
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
    readyToCreate: boolean;
    intent: 'place_order' | 'order_status' | 'other';
    orderNumber: string | null;
}
export declare class AiService {
    private readonly prisma;
    private readonly llm;
    private readonly metering;
    private readonly platformSetting;
    private readonly audio;
    private readonly rag;
    private readonly inflight;
    constructor(prisma: PrismaService, llm: LlmService, metering: AiMeteringService, platformSetting: PlatformSettingService, audio: AudioTranscriptionService, rag: AiRagService);
    suggestReply(companyId: number, userId: number | null, conversationId: number, instruction?: string): Promise<{
        text: string;
    }>;
    summarize(companyId: number, userId: number | null, conversationId: number): Promise<{
        text: string;
    }>;
    draftOrder(companyId: number, userId: number | null, conversationId: number): Promise<DraftOrderResult>;
    composeOrderConfirmation(companyId: number, conversationId: number, cart: {
        items: Array<{
            quantity: number;
            title: string;
        }>;
        name: string;
        phone: string;
        address1: string;
        city: string;
        payment: 'cod' | 'prepaid';
    }): Promise<{
        text: string;
    }>;
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
        skip?: boolean;
    }>;
    private parseDecision;
    private parseDraftOrder;
    private acquire;
    private release;
    private languageRule;
    private loadCompany;
    private loadKnowledge;
    private buildKnowledge;
    private baseSystem;
    private loadTranscript;
}
