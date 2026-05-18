export declare enum SendMessageType {
    text = "text",
    image = "image",
    audio = "audio",
    video = "video",
    document = "document",
    template = "template"
}
export declare class SendMessageDto {
    type: SendMessageType;
    content?: string;
    templateId?: number;
    variables?: Record<string, string>;
    mediaPath?: string;
    contextMessageId?: number;
}
