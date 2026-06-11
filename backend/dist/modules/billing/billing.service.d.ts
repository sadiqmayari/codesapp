import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { InvoiceGeneratorService } from './invoice-generator.service';
import { LimitNotifierService } from './limit-notifier.service';
import { AiMeteringService } from '../ai/ai-metering.service';
import { ListInvoicesDto } from './dtos/list-invoices.dto';
import { RequestPlanChangeDto } from './dtos/request-plan-change.dto';
import { CompanyStatusService } from '../../common/services/company-status.service';
import { MailService } from '../../common/services/mail.service';
export declare class BillingService {
    private readonly prisma;
    private readonly invoiceGen;
    private readonly limitNotifier;
    private readonly aiMetering;
    private readonly companyStatus;
    private readonly mail;
    private readonly config;
    constructor(prisma: PrismaService, invoiceGen: InvoiceGeneratorService, limitNotifier: LimitNotifierService, aiMetering: AiMeteringService, companyStatus: CompanyStatusService, mail: MailService, config: ConfigService);
    listInvoices(companyId: number, dto: ListInvoicesDto): Promise<{
        success: boolean;
        data: {
            status: import(".prisma/client").$Enums.InvoiceStatus;
            created_at: Date;
            id: number;
            company_id: number;
            period: string | null;
            invoice_number: string | null;
            amount: Prisma.Decimal;
            due_date: Date;
            paid_at: Date | null;
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
        company: {
            id: number;
            name: string;
            address: string | null;
            logo_url: string | null;
            timezone: string | null;
            activated_at: Date | null;
            owner: {
                name: string;
                email: string;
            };
            plan: {
                plan_name: string;
                monthly_price: Prisma.Decimal;
                setup_fee: Prisma.Decimal;
            };
        };
        status: import(".prisma/client").$Enums.InvoiceStatus;
        created_at: Date;
        id: number;
        company_id: number;
        period: string | null;
        invoice_number: string | null;
        amount: Prisma.Decimal;
        due_date: Date;
        paid_at: Date | null;
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
        aiUsage: {
            billedCents: number;
            cycleStart: string;
            nextInvoiceDate: string;
        } | null;
        features: {
            webhookEnabled: boolean;
            aiEnabled: boolean;
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
        period: string | null;
        invoice_number: string | null;
        amount: Prisma.Decimal;
        due_date: Date;
        paid_at: Date | null;
        description: string | null;
        plan_snapshot: Prisma.JsonValue | null;
    }>;
    private maybeReactivate;
    generateInvoices(): Promise<{
        created: number;
        skipped: number;
    }>;
    rewriteLegacyInvoices(opts: {
        dryRun: boolean;
        companyId?: number | null;
    }): Promise<{
        mode: 'dry-run' | 'apply';
        inspected: number;
        candidates: number;
        skipped: number;
        updated: number;
        collisions: Array<{
            id: number;
            collidesWith: number;
        }>;
        changes: Array<{
            id: number;
            companyId: number;
            companyName: string | null;
            oldNumber: string | null;
            newNumber: string;
            newDueDate: string;
            newPeriod: string;
        }>;
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
            period: string | null;
            invoice_number: string | null;
            amount: Prisma.Decimal;
            due_date: Date;
            paid_at: Date | null;
            description: string | null;
            plan_snapshot: Prisma.JsonValue | null;
        }[];
    }>;
    getMyPlanRequest(companyId: number): Promise<{
        request: null;
    } | {
        request: {
            requestedPlanName: string | null;
            status: string;
            created_at: Date;
            id: number;
            updated_at: Date;
            company_id: number;
            note: string | null;
            requested_subscription_id: number | null;
            current_subscription_id: number | null;
            created_by_user_id: number | null;
            resolved_at: Date | null;
            resolution_note: string | null;
        };
    }>;
    requestPlanChange(companyId: number, userId: number | null, dto: RequestPlanChangeDto): Promise<{
        request: {
            requestedPlanName: string | null;
            status: string;
            created_at: Date;
            id: number;
            updated_at: Date;
            company_id: number;
            note: string | null;
            requested_subscription_id: number | null;
            current_subscription_id: number | null;
            created_by_user_id: number | null;
            resolved_at: Date | null;
            resolution_note: string | null;
        };
    }>;
}
