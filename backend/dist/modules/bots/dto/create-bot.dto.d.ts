export declare enum BotTriggerType {
    exact = "exact",
    contains = "contains",
    regex = "regex"
}
export declare enum BotActionType {
    reply_template = "reply_template",
    send_text = "send_text",
    assign_agent = "assign_agent",
    apply_tag = "apply_tag",
    fire_webhook = "fire_webhook",
    ai_reply = "ai_reply"
}
export declare class BotActionDto {
    type: BotActionType;
    templateId?: number;
    variables?: Record<string, string>;
    message?: string;
    userId?: number;
    tag?: string;
    webhookEndpointId?: number;
}
export declare class CreateBotDto {
    name: string;
    triggerType: BotTriggerType;
    keyword: string;
    actions: BotActionDto[];
}
