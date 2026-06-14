import { WorkItem } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkItemService } from './work-item.service';
export type RouteIntent = 'sales' | 'order' | 'logistics' | 'resolution' | 'general' | 'escalate' | 'closing';
export declare class RouterService {
    private readonly prisma;
    private readonly workItems;
    private readonly logger;
    constructor(prisma: PrismaService, workItems: WorkItemService);
    private typeForIntent;
    route(params: {
        companyId: number;
        conversationId: number;
        messageId: number;
        intent: RouteIntent;
        contactId?: number | null;
    }): Promise<WorkItem | null>;
}
