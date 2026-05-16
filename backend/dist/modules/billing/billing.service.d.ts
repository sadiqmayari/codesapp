import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InvoiceGeneratorService } from './invoice-generator.service';
import { ListInvoicesDto } from './dtos/list-invoices.dto';
export declare class BillingService {
    private readonly prisma;
    private readonly invoiceGen;
    constructor(prisma: PrismaService, invoiceGen: InvoiceGeneratorService);
    listInvoices(companyId: number, dto: ListInvoicesDto): Promise<{
        success: boolean;
        data: {
            id: number;
            company_id: number;
            status: import(".prisma/client").$Enums.InvoiceStatus;
            created_at: Date;
            amount: Prisma.Decimal;
            due_date: Date;
            paid_at: Date | null;
            invoice_number: string | null;
            period: string | null;
            description: string | null;
            plan_snapshot: Prisma.JsonValue | null;
        }[];
        message: string;
        meta: {
            page: number;
            limit: number;
            total: number;
        };
    }>;
    getInvoice(companyId: number, id: number): Promise<{
        id: number;
        company_id: number;
        status: import(".prisma/client").$Enums.InvoiceStatus;
        created_at: Date;
        amount: Prisma.Decimal;
        due_date: Date;
        paid_at: Date | null;
        invoice_number: string | null;
        period: string | null;
        description: string | null;
        plan_snapshot: Prisma.JsonValue | null;
    }>;
    getSubscription(companyId: number): Promise<{
        plan: string;
        monthlyPrice: Prisma.Decimal;
        limits: {
            contactLimit: number;
            templateLimit: number;
            userLimit: number;
        };
        period: string;
        usage: {
            messagesSent: number;
            contactsStored: number;
            templatesUsed: number;
            webhookCalls: number;
            conversationsOpened: number;
        };
    }>;
    overview(): Promise<{
        mrr: number;
        revenueByPlan: {
            plan: string;
            companies: number;
            mrr: number;
        }[];
        overdueCount: number;
    }>;
    markPaid(invoiceId: number): Promise<{
        id: number;
        company_id: number;
        status: import(".prisma/client").$Enums.InvoiceStatus;
        created_at: Date;
        amount: Prisma.Decimal;
        due_date: Date;
        paid_at: Date | null;
        invoice_number: string | null;
        period: string | null;
        description: string | null;
        plan_snapshot: Prisma.JsonValue | null;
    }>;
    generateInvoices(): Promise<{
        period: string;
        created: number;
        skipped: number;
    }>;
    autoInvoiceCron(): Promise<{
        ran: boolean;
        reason: string;
        day: number;
    } | {
        period: string;
        created: number;
        skipped: number;
        ran: boolean;
        reason?: undefined;
        day?: undefined;
    }>;
}
