export declare class SuggestReplyDto {
    conversationId: number;
    instruction?: string;
}
export declare class SummarizeDto {
    conversationId: number;
}
export type RewriteMode = 'polite' | 'shorten' | 'expand' | 'fix';
export declare class RewriteDto {
    text: string;
    mode: RewriteMode;
}
export declare class TranslateDto {
    text: string;
    targetLang: string;
}
