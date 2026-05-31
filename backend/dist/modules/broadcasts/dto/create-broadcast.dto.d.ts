import { SegmentFilterDto } from '../../contacts/dto/create-segment.dto';
export declare class CreateBroadcastDto {
    name: string;
    templateId: number;
    all?: boolean;
    contactIds?: number[];
    filter?: SegmentFilterDto;
    segmentId?: number;
    variables?: Record<string, string>;
}
