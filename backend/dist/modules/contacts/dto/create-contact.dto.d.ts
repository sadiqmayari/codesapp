export declare const PHONE_REGEX: RegExp;
export declare class CreateContactDto {
    name: string;
    phone: string;
    email?: string;
    tags?: string[];
    customFields?: Record<string, unknown>;
}
