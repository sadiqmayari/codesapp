import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../../common/services/encryption.service';
import { PrismaService } from '../../prisma/prisma.service';
export interface MetaContext {
    message_id: string;
}
export interface MetaTextPayload {
    messaging_product: 'whatsapp';
    recipient_type?: 'individual';
    to: string;
    type: 'text';
    text: {
        body: string;
        preview_url?: boolean;
    };
    context?: MetaContext;
}
export interface MetaMediaPayload {
    messaging_product: 'whatsapp';
    recipient_type?: 'individual';
    to: string;
    type: 'image' | 'audio' | 'video' | 'document';
    image?: {
        link?: string;
        id?: string;
        caption?: string;
    };
    audio?: {
        link?: string;
        id?: string;
    };
    video?: {
        link?: string;
        id?: string;
        caption?: string;
    };
    document?: {
        link?: string;
        id?: string;
        caption?: string;
        filename?: string;
    };
    context?: MetaContext;
}
export interface MetaTemplatePayload {
    messaging_product: 'whatsapp';
    recipient_type?: 'individual';
    to: string;
    type: 'template';
    template: {
        name: string;
        language: {
            code: string;
        };
        components?: unknown[];
    };
    context?: MetaContext;
}
export type MetaSendPayload = MetaTextPayload | MetaMediaPayload | MetaTemplatePayload;
export interface MetaSendResponse {
    messaging_product: string;
    contacts?: {
        input: string;
        wa_id: string;
    }[];
    messages?: {
        id: string;
    }[];
}
export declare class MetaClientService {
    private readonly config;
    private readonly prisma;
    private readonly encryption;
    private readonly logger;
    private readonly graphVersion;
    private readonly graphHost;
    constructor(config: ConfigService, prisma: PrismaService, encryption: EncryptionService);
    getAccessToken(companyId: number): Promise<string | null>;
    assertOnboarded(companyId: number): Promise<void>;
    sendMessage(companyId: number, phoneNumberId: string, payload: MetaSendPayload): Promise<MetaSendResponse>;
    sendTemplate(companyId: number, phoneNumberId: string, to: string, templateName: string, languageCode: string, components?: unknown[]): Promise<MetaSendResponse>;
    uploadMedia(companyId: number, fileBuffer: Buffer, mimeType: string, filename: string): Promise<{
        mediaId: string;
    }>;
    getMedia(companyId: number, mediaId: string): Promise<{
        url: string;
        mime_type: string;
        sha256?: string;
        file_size?: number;
    }>;
    downloadMedia(companyId: number, mediaId: string, storageRoot: string, maxBytes: number): Promise<{
        path: string;
        filename: string;
        mime: string;
        bytes: number;
    }>;
    private extFromMime;
    private postJson;
    private getJson;
    private request;
    private requestBuffer;
    private extractMetaError;
    private streamUrlToFile;
}
