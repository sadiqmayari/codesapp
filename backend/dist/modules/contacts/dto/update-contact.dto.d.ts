export declare enum ContactStatus {
    active = "active",
    blocked = "blocked",
    archived = "archived"
}
export declare class UpdateContactDto {
    name?: string;
    email?: string;
    tags?: string[];
    customFields?: Record<string, unknown>;
    status?: ContactStatus;
}
