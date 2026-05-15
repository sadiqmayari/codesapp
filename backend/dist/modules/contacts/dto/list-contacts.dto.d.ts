import { ContactStatus } from './update-contact.dto';
export declare class ListContactsDto {
    search?: string;
    tag?: string;
    status?: ContactStatus;
    segmentId?: number;
    page?: number;
    limit?: number;
}
