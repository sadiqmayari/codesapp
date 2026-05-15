import { BotActionDto, BotTriggerType } from './create-bot.dto';
export declare class UpdateBotDto {
    name?: string;
    triggerType?: BotTriggerType;
    keyword?: string;
    actions?: BotActionDto[];
}
