import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InvoiceGeneratorService } from './invoice-generator.service';
import { LimitNotifierService } from './limit-notifier.service';
import { ListInvoicesDto } from './dtos/list-invoices.dto';
export declare class BillingService {
    private readonly prisma;
    private readonly invoiceGen;
    private readonly limitNotifier;
    constructor(prisma: PrismaService, invoiceGen: InvoiceGeneratorService, limitNotifier: LimitNotifierService);
    listInvoices(companyId: number, dto: ListInvoicesDto): Promise<{
        success: boolean;
        data: {
            status: import(".prisma/client").$Enums.InvoiceStatus;
            created_at: Date;
            id: number;
            company_id: number;
            description: string | null;
            period: string | null;
            amount: Prisma.Decimal;
            due_date: Date;
            paid_at: Date | null;
            invoice_number: string | null;
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
        status: import(".prisma/client").$Enums.InvoiceStatus;
        created_at: Date;
        id: number;
        company_id: number;
        description: string | null;
        period: string | null;
        amount: Prisma.Decimal;
        due_date: Date;
        paid_at: Date | null;
        invoice_number: string | null;
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
        status: import(".prisma/client").$Enums.InvoiceStatus;
        created_at: Date;
        id: number;
        company_id: number;
        description: string | null;
        period: string | null;
        amount: Prisma.Decimal;
        due_date: Date;
        paid_at: Date | null;
        invoice_number: string | null;
        plan_snapshot: Prisma.JsonValue | null;
    }>;
    private maybeReactivate;
    generateInvoices(): Promise<{
        created: number;
        skipped: number;
    }>;
    autoInvoiceCron(): Promise<{
        created: number;
        skipped: number;
        ran: boolean;
    }>;
    enforceCron(): Promise<{
        ran: boolean;
        markedOverdue: number;
        suspended: number;
    }>;
    accountStatus(companyId: number): Promise<{
        activationStatus: import(".prisma/client").$Enums.ActivationStatus;
        suspendedForBilling: boolean;
        suspendedAt: Date | null;
        graceUntil: Date | null;
        unpaidInvoices: {
            status: import(".prisma/client").$Enums.InvoiceStatus;
            created_at: Date;
            id: number;
            company_id: number;
            description: string | null;
            period: string | null;
            amount: Prisma.Decimal;
            due_date: Date;
            paid_at: Date | null;
            invoice_number: string | null;
            plan_snapshot: Prisma.JsonValue | null;
        }[];
    }>;
}
