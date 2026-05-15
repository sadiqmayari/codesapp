import { ContactStatus } from './update-contact.dto';
export declare class SegmentFilterDto {
    tags?: string[];
    status?: ContactStatus;
    lastMessageAfter?: string;
    lastMessageBefore?: string;
    hasEmail?: boolean;
}
export declare class CreateSegmentDto {
    name: string;
    filter: SegmentFilterDto;
}
export declare class UpdateSegmentDto {
    name?: string;
    filter?: SegmentFilterDto;
}
