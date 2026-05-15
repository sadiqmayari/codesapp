import { TemplateCategory } from './create-template.dto';
export declare enum TemplateStatus {
    pending = "pending",
    approved = "approved",
    rejected = "rejected",
    paused = "paused"
}
export declare class ListTemplatesDto {
    status?: TemplateStatus;
    category?: TemplateCategory;
}
