export declare class UpdateAiSettingsDto {
    aiEnabled?: boolean;
    aiTier?: 'fast' | 'smart' | null;
    visionEnabled?: boolean;
    voiceEnabled?: boolean;
    autoReplyEnabled?: boolean;
    autoOrderEnabled?: boolean;
    autoOrderAllEnabled?: boolean;
    brandTone?: string | null;
    defaultLanguage?: string | null;
    monthlyCapCents?: number | null;
}
