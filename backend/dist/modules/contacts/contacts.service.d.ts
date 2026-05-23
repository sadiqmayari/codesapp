import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { SegmentsService } from './segments.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { ListContactsDto } from './dto/list-contacts.dto';
export declare class ContactsService {
    private readonly prisma;
    private readonly metering;
    private readonly segmentsService;
    private readonly webhookDispatcher;
    constructor(prisma: PrismaService, metering: UsageMeteringService, segmentsService: SegmentsService, webhookDispatcher: WebhookDispatcherService);
    list(companyId: number, dto: ListContactsDto): Promise<{
        success: boolean;
        data: {
            status: import(".prisma/client").$Enums.ContactStatus;
            created_at: Date;
            id: number;
            name: string;
            email: string | null;
            company_id: number;
            deleted_at: Date | null;
            last_message_at: Date | null;
            phone: string;
            tags: Prisma.JsonValue;
            custom_fields: Prisma.JsonValue;
        }[];
        message: string;
        meta: {
            page: number;
            limit: number;
            total: number;
        };
    }>;
    get(companyId: number, id: number): Promise<{
        status: import(".prisma/client").$Enums.ContactStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string | null;
        company_id: number;
        deleted_at: Date | null;
        last_message_at: Date | null;
        phone: string;
        tags: Prisma.JsonValue;
        custom_fields: Prisma.JsonValue;
    }>;
    create(companyId: number, dto: CreateContactDto): Promise<{
        status: import(".prisma/client").$Enums.ContactStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string | null;
        company_id: number;
        deleted_at: Date | null;
        last_message_at: Date | null;
        phone: string;
        tags: Prisma.JsonValue;
        custom_fields: Prisma.JsonValue;
    }>;
    update(companyId: number, id: number, dto: UpdateContactDto): Promise<{
        status: import(".prisma/client").$Enums.ContactStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string | null;
        company_id: number;
        deleted_at: Date | null;
        last_message_at: Date | null;
        phone: string;
        tags: Prisma.JsonValue;
        custom_fields: Prisma.JsonValue;
    }>;
    softDelete(companyId: number, id: number): Promise<{
        ok: boolean;
    }>;
    distinctTags(companyId: number): Promise<string[]>;
}
