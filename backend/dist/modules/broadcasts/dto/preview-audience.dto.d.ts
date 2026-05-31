import { SegmentFilterDto } from '../../contacts/dto/create-segment.dto';
export declare class PreviewAudienceDto {
    all?: boolean;
    contactIds?: number[];
    filter?: SegmentFilterDto;
    segmentId?: number;
}
