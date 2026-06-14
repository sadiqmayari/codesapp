import { WorkItemService } from '../engagement/work-item.service';
export declare class EngagementCronController {
    private readonly workItems;
    constructor(workItems: WorkItemService);
    slaSweep(): Promise<{
        swept: number;
        conversationIds: number[];
    }>;
}
