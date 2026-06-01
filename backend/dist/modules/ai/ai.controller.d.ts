import { AiService } from './ai.service';
import { AiMeteringService } from './ai-metering.service';
import { RewriteDto, SuggestReplyDto, SummarizeDto, TranslateDto } from './dto/ai-actions.dto';
type AuthUser = {
    companyId: number;
    userId: number;
};
export declare class AiController {
    private readonly ai;
    private readonly metering;
    constructor(ai: AiService, metering: AiMeteringService);
    suggestReply(user: AuthUser, dto: SuggestReplyDto): Promise<{
        text: string;
    }>;
    summarize(user: AuthUser, dto: SummarizeDto): Promise<{
        text: string;
    }>;
    rewrite(user: AuthUser, dto: RewriteDto): Promise<{
        text: string;
    }>;
    translate(user: AuthUser, dto: TranslateDto): Promise<{
        text: string;
    }>;
    usage(user: AuthUser): Promise<import("./ai-metering.service").AiMonthlyUsage>;
}
export {};
