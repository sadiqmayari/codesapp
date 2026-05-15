export declare enum TemplateCategory {
    marketing = "marketing",
    utility = "utility",
    authentication = "authentication"
}
export declare class CreateTemplateDto {
    name: string;
    category: TemplateCategory;
    language: string;
    components: Array<Record<string, unknown>>;
}
