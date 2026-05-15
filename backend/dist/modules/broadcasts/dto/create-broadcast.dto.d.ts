import { SegmentFilterDto } from '../../contacts/dto/create-segment.dto';
export declare class CreateBroadcastDto {
    name: string;
    templateId: number;
    contactIds?: number[];
    filter?: SegmentFilterDto;
    segmentId?: number;
    variables?: Record<string, string>;
}
