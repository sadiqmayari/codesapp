import { PrismaService } from '../../prisma/prisma.service';
export interface StoredUsage {
    contacts: number;
    templates: number;
    users: number;
}
export declare function getStoredUsage(prisma: PrismaService, companyId: number): Promise<StoredUsage>;
