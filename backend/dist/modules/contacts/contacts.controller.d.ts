import { ContactsService } from './contacts.service';
import { CsvImportService } from './csv-import.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { ListContactsDto } from './dto/list-contacts.dto';
interface UploadedCsvFile {
    buffer: Buffer;
    size: number;
    originalname: string;
    mimetype: string;
}
export declare class ContactsController {
    private readonly contactsService;
    private readonly csvImport;
    constructor(contactsService: ContactsService, csvImport: CsvImportService);
    list(user: {
        companyId: number;
    }, dto: ListContactsDto): Promise<{
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
            tags: import("@prisma/client/runtime/library").JsonValue;
            custom_fields: import("@prisma/client/runtime/library").JsonValue;
        }[];
        message: string;
        meta: {
            page: number;
            limit: number;
            total: number;
        };
    }>;
    tags(user: {
        companyId: number;
    }): Promise<string[]>;
    get(user: {
        companyId: number;
    }, id: number): Promise<{
        status: import(".prisma/client").$Enums.ContactStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string | null;
        company_id: number;
        deleted_at: Date | null;
        last_message_at: Date | null;
        phone: string;
        tags: import("@prisma/client/runtime/library").JsonValue;
        custom_fields: import("@prisma/client/runtime/library").JsonValue;
    }>;
    create(user: {
        companyId: number;
    }, dto: CreateContactDto): Promise<{
        status: import(".prisma/client").$Enums.ContactStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string | null;
        company_id: number;
        deleted_at: Date | null;
        last_message_at: Date | null;
        phone: string;
        tags: import("@prisma/client/runtime/library").JsonValue;
        custom_fields: import("@prisma/client/runtime/library").JsonValue;
    }>;
    update(user: {
        companyId: number;
    }, id: number, dto: UpdateContactDto): Promise<{
        status: import(".prisma/client").$Enums.ContactStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string | null;
        company_id: number;
        deleted_at: Date | null;
        last_message_at: Date | null;
        phone: string;
        tags: import("@prisma/client/runtime/library").JsonValue;
        custom_fields: import("@prisma/client/runtime/library").JsonValue;
    }>;
    remove(user: {
        companyId: number;
    }, id: number): Promise<{
        ok: boolean;
    }>;
    import(user: {
        companyId: number;
    }, file: UploadedCsvFile): Promise<import("./csv-import.service").CsvImportSummary>;
}
export {};
