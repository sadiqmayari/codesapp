import { PrismaService } from '../../prisma/prisma.service';
export declare class InvoiceGeneratorService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    static currentPeriod(): string;
    static invoiceNumber(period: string, companyId: number): string;
    generateForPeriod(period: string): Promise<{
        period: string;
        created: number;
        skipped: number;
    }>;
}
