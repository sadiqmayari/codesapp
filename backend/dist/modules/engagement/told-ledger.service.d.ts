import { PrismaService } from '../../prisma/prisma.service';
export declare class ToldLedgerService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    private hash;
    noteAndCheck(companyId: number, workItemId: number, factKind: string, value: string): Promise<{
        alreadyTold: boolean;
    }>;
    kindsTold(workItemId: number): Promise<string[]>;
}
