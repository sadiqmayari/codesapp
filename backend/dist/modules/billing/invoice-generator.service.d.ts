import { PrismaService } from '../../prisma/prisma.service';
export declare class InvoiceGeneratorService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    static currentPeriod(): string;
    static cycleIndex(activatedAt: Date, now: Date): number;
    static cycleStart(activatedAt: Date, index: number): Date;
    static invoiceNumber(companyId: number, cycleStart: Date): string;
    generateDueInvoices(now?: Date): Promise<{
        created: number;
        skipped: number;
    }>;
}
