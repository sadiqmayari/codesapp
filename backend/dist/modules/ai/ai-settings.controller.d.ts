import { AiSettingsService } from './ai-settings.service';
import { UpdateAiSettingsDto } from './dto/ai-settings.dto';
export declare class AiSettingsController {
    private readonly settings;
    constructor(settings: AiSettingsService);
    get(user: {
        companyId: number;
    }): Promise<import("./ai-settings.service").AiSettingsView>;
    update(user: {
        companyId: number;
    }, dto: UpdateAiSettingsDto): Promise<import("./ai-settings.service").AiSettingsView>;
}
