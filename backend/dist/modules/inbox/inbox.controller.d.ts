import { InboxService } from './inbox.service';
import { AssignDto } from './dto/assign.dto';
import { AddLabelDto } from './dto/add-label.dto';
import { AddNoteDto } from './dto/add-note.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { ListConversationsDto } from './dto/list-conversations.dto';
export declare class InboxController {
    private readonly inboxService;
    constructor(inboxService: InboxService);
    list(user: {
        companyId: number;
    }, dto: ListConversationsDto): Promise<{
        success: boolean;
        data: ({
            contact: {
                id: number;
                email: string | null;
                name: string;
                phone: string;
            };
            assigned_user: {
                id: number;
                email: string;
                name: string;
            } | null;
            labels: {
                label: string;
            }[];
        } & {
            id: number;
            company_id: number;
            status: import(".prisma/client").$Enums.ConversationStatus;
            created_at: Date;
            updated_at: Date;
            contact_id: number;
            assigned_user_id: number | null;
            last_message: string | null;
            window_expires_at: Date | null;
            unread_count: number;
            deleted_at: Date | null;
        })[];
        message: string;
        meta: {
            page: number;
            limit: number;
            total: number;
        };
    }>;
    get(user: {
        companyId: number;
    }, id: number): Promise<{
        contact: {
            id: number;
            email: string | null;
            company_id: number;
            name: string;
            status: import(".prisma/client").$Enums.ContactStatus;
            created_at: Date;
            deleted_at: Date | null;
            phone: string;
            tags: import("@prisma/client/runtime/library").JsonValue;
            custom_fields: import("@prisma/client/runtime/library").JsonValue;
            last_message_at: Date | null;
        };
        assigned_user: {
            id: number;
            email: string;
            name: string;
        } | null;
        labels: {
            id: number;
            label: string;
        }[];
    } & {
        id: number;
        company_id: number;
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        updated_at: Date;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    assign(user: {
        companyId: number;
    }, id: number, dto: AssignDto): Promise<{
        id: number;
        company_id: number;
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        updated_at: Date;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    resolve(user: {
        companyId: number;
    }, id: number): Promise<{
        id: number;
        company_id: number;
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        updated_at: Date;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    reopen(user: {
        companyId: number;
    }, id: number): Promise<{
        id: number;
        company_id: number;
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        updated_at: Date;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    addLabel(user: {
        companyId: number;
    }, id: number, dto: AddLabelDto): Promise<{
        id: number;
        company_id: number;
        created_at: Date;
        conversation_id: number;
        label: string;
    }>;
    removeLabel(user: {
        companyId: number;
    }, id: number, label: string): Promise<{
        removed: boolean;
    }>;
    addNote(user: {
        companyId: number;
        userId: number;
    }, id: number, dto: AddNoteDto): Promise<{
        id: number;
        company_id: number;
        created_at: Date;
        user_id: number;
        conversation_id: number;
        body: string;
    }>;
    listNotes(user: {
        companyId: number;
    }, id: number): Promise<{
        id: number;
        company_id: number;
        created_at: Date;
        user_id: number;
        conversation_id: number;
        body: string;
    }[]>;
    messages(user: {
        companyId: number;
    }, id: number, cursor?: string, limit?: string): Promise<{
        rows: {
            id: number;
            company_id: number;
            status: import(".prisma/client").$Enums.MessageStatus;
            created_at: Date;
            conversation_id: number;
            direction: import(".prisma/client").$Enums.MessageDirection;
            read_at: Date | null;
            broadcast_id: number | null;
            message_type: import(".prisma/client").$Enums.MessageType;
            content: string | null;
            media_url: string | null;
            meta_media_url: string | null;
            media_expires_at: Date | null;
            media_expired: boolean;
            meta_message_id: string | null;
            read_by_user_id: number | null;
            timestamp: Date;
        }[];
        nextCursor: number | null;
    }>;
    send(user: {
        companyId: number;
    }, id: number, dto: SendMessageDto): Promise<{
        id: number;
        company_id: number;
        status: import(".prisma/client").$Enums.MessageStatus;
        created_at: Date;
        conversation_id: number;
        direction: import(".prisma/client").$Enums.MessageDirection;
        read_at: Date | null;
        broadcast_id: number | null;
        message_type: import(".prisma/client").$Enums.MessageType;
        content: string | null;
        media_url: string | null;
        meta_media_url: string | null;
        media_expires_at: Date | null;
        media_expired: boolean;
        meta_message_id: string | null;
        read_by_user_id: number | null;
        timestamp: Date;
    }>;
    markRead(user: {
        companyId: number;
        userId: number;
    }, id: number): Promise<{
        ok: boolean;
    }>;
}
