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
                name: string;
                email: string | null;
                phone: string;
            };
            assigned_user: {
                id: number;
                name: string;
                email: string;
            } | null;
            labels: {
                label: string;
            }[];
        } & {
            status: import(".prisma/client").$Enums.ConversationStatus;
            created_at: Date;
            id: number;
            updated_at: Date;
            company_id: number;
            contact_id: number;
            assigned_user_id: number | null;
            last_message: string | null;
            last_message_at: Date | null;
            pinned_at: Date | null;
            cleared_before: Date | null;
            ai_autoreply: boolean | null;
            ai_order_created_at: Date | null;
            ai_pending_order: import("@prisma/client/runtime/library").JsonValue | null;
            ai_pending_order_at: Date | null;
            ai_last_order_signature: string | null;
            ai_closed_at: Date | null;
            ai_awaiting_payment_at: Date | null;
            ai_active_topic: string | null;
            ai_topic_started_at: Date | null;
            ai_topic_expires_at: Date | null;
            ai_episode_started_at: Date | null;
            ai_linked_order_id: string | null;
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
            status: import(".prisma/client").$Enums.ContactStatus;
            created_at: Date;
            id: number;
            name: string;
            company_id: number;
            email: string | null;
            last_message_at: Date | null;
            deleted_at: Date | null;
            phone: string;
            tags: import("@prisma/client/runtime/library").JsonValue;
            custom_fields: import("@prisma/client/runtime/library").JsonValue;
        };
        assigned_user: {
            id: number;
            name: string;
            email: string;
        } | null;
        labels: {
            id: number;
            label: string;
        }[];
    } & {
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        last_message_at: Date | null;
        pinned_at: Date | null;
        cleared_before: Date | null;
        ai_autoreply: boolean | null;
        ai_order_created_at: Date | null;
        ai_pending_order: import("@prisma/client/runtime/library").JsonValue | null;
        ai_pending_order_at: Date | null;
        ai_last_order_signature: string | null;
        ai_closed_at: Date | null;
        ai_awaiting_payment_at: Date | null;
        ai_active_topic: string | null;
        ai_topic_started_at: Date | null;
        ai_topic_expires_at: Date | null;
        ai_episode_started_at: Date | null;
        ai_linked_order_id: string | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    assign(user: {
        companyId: number;
    }, id: number, dto: AssignDto): Promise<{
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        last_message_at: Date | null;
        pinned_at: Date | null;
        cleared_before: Date | null;
        ai_autoreply: boolean | null;
        ai_order_created_at: Date | null;
        ai_pending_order: import("@prisma/client/runtime/library").JsonValue | null;
        ai_pending_order_at: Date | null;
        ai_last_order_signature: string | null;
        ai_closed_at: Date | null;
        ai_awaiting_payment_at: Date | null;
        ai_active_topic: string | null;
        ai_topic_started_at: Date | null;
        ai_topic_expires_at: Date | null;
        ai_episode_started_at: Date | null;
        ai_linked_order_id: string | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    resolve(user: {
        companyId: number;
    }, id: number): Promise<{
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        last_message_at: Date | null;
        pinned_at: Date | null;
        cleared_before: Date | null;
        ai_autoreply: boolean | null;
        ai_order_created_at: Date | null;
        ai_pending_order: import("@prisma/client/runtime/library").JsonValue | null;
        ai_pending_order_at: Date | null;
        ai_last_order_signature: string | null;
        ai_closed_at: Date | null;
        ai_awaiting_payment_at: Date | null;
        ai_active_topic: string | null;
        ai_topic_started_at: Date | null;
        ai_topic_expires_at: Date | null;
        ai_episode_started_at: Date | null;
        ai_linked_order_id: string | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    reopen(user: {
        companyId: number;
    }, id: number): Promise<{
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        last_message_at: Date | null;
        pinned_at: Date | null;
        cleared_before: Date | null;
        ai_autoreply: boolean | null;
        ai_order_created_at: Date | null;
        ai_pending_order: import("@prisma/client/runtime/library").JsonValue | null;
        ai_pending_order_at: Date | null;
        ai_last_order_signature: string | null;
        ai_closed_at: Date | null;
        ai_awaiting_payment_at: Date | null;
        ai_active_topic: string | null;
        ai_topic_started_at: Date | null;
        ai_topic_expires_at: Date | null;
        ai_episode_started_at: Date | null;
        ai_linked_order_id: string | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    addLabel(user: {
        companyId: number;
    }, id: number, dto: AddLabelDto): Promise<{
        created_at: Date;
        id: number;
        company_id: number;
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
        created_at: Date;
        id: number;
        company_id: number;
        user_id: number;
        conversation_id: number;
        body: string;
    }>;
    listNotes(user: {
        companyId: number;
    }, id: number): Promise<{
        created_at: Date;
        id: number;
        company_id: number;
        user_id: number;
        conversation_id: number;
        body: string;
    }[]>;
    messages(user: {
        companyId: number;
    }, id: number, cursor?: string, limit?: string): Promise<{
        rows: ({
            context_message: {
                id: number;
                content: string | null;
                message_type: import(".prisma/client").$Enums.MessageType;
                direction: import(".prisma/client").$Enums.MessageDirection;
                media_url: string | null;
            } | null;
        } & {
            status: import(".prisma/client").$Enums.MessageStatus;
            created_at: Date;
            id: number;
            transcription: string | null;
            company_id: number;
            content: string | null;
            user_id: number | null;
            conversation_id: number;
            broadcast_id: number | null;
            message_type: import(".prisma/client").$Enums.MessageType;
            direction: import(".prisma/client").$Enums.MessageDirection;
            media_url: string | null;
            meta_media_url: string | null;
            media_expires_at: Date | null;
            media_expired: boolean;
            reaction: string | null;
            meta_message_id: string | null;
            read_at: Date | null;
            read_by_user_id: number | null;
            context_message_id: number | null;
            timestamp: Date;
        })[];
        nextCursor: number | null;
    }>;
    send(user: {
        companyId: number;
        userId: number;
    }, id: number, dto: SendMessageDto): Promise<{
        context_message: {
            id: number;
            content: string | null;
            message_type: import(".prisma/client").$Enums.MessageType;
            direction: import(".prisma/client").$Enums.MessageDirection;
            media_url: string | null;
        } | null;
    } & {
        status: import(".prisma/client").$Enums.MessageStatus;
        created_at: Date;
        id: number;
        transcription: string | null;
        company_id: number;
        content: string | null;
        user_id: number | null;
        conversation_id: number;
        broadcast_id: number | null;
        message_type: import(".prisma/client").$Enums.MessageType;
        direction: import(".prisma/client").$Enums.MessageDirection;
        media_url: string | null;
        meta_media_url: string | null;
        media_expires_at: Date | null;
        media_expired: boolean;
        reaction: string | null;
        meta_message_id: string | null;
        read_at: Date | null;
        read_by_user_id: number | null;
        context_message_id: number | null;
        timestamp: Date;
    }>;
    sendMedia(user: {
        companyId: number;
        userId: number;
    }, id: number, file: {
        buffer: Buffer;
        mimetype: string;
        originalname?: string;
        size: number;
    } | undefined, caption?: string, contextMessageId?: string): Promise<{
        context_message: {
            id: number;
            content: string | null;
            message_type: import(".prisma/client").$Enums.MessageType;
            direction: import(".prisma/client").$Enums.MessageDirection;
            media_url: string | null;
        } | null;
    } & {
        status: import(".prisma/client").$Enums.MessageStatus;
        created_at: Date;
        id: number;
        transcription: string | null;
        company_id: number;
        content: string | null;
        user_id: number | null;
        conversation_id: number;
        broadcast_id: number | null;
        message_type: import(".prisma/client").$Enums.MessageType;
        direction: import(".prisma/client").$Enums.MessageDirection;
        media_url: string | null;
        meta_media_url: string | null;
        media_expires_at: Date | null;
        media_expired: boolean;
        reaction: string | null;
        meta_message_id: string | null;
        read_at: Date | null;
        read_by_user_id: number | null;
        context_message_id: number | null;
        timestamp: Date;
    }>;
    pin(user: {
        companyId: number;
    }, id: number): Promise<{
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        last_message_at: Date | null;
        pinned_at: Date | null;
        cleared_before: Date | null;
        ai_autoreply: boolean | null;
        ai_order_created_at: Date | null;
        ai_pending_order: import("@prisma/client/runtime/library").JsonValue | null;
        ai_pending_order_at: Date | null;
        ai_last_order_signature: string | null;
        ai_closed_at: Date | null;
        ai_awaiting_payment_at: Date | null;
        ai_active_topic: string | null;
        ai_topic_started_at: Date | null;
        ai_topic_expires_at: Date | null;
        ai_episode_started_at: Date | null;
        ai_linked_order_id: string | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    unpin(user: {
        companyId: number;
    }, id: number): Promise<{
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        last_message_at: Date | null;
        pinned_at: Date | null;
        cleared_before: Date | null;
        ai_autoreply: boolean | null;
        ai_order_created_at: Date | null;
        ai_pending_order: import("@prisma/client/runtime/library").JsonValue | null;
        ai_pending_order_at: Date | null;
        ai_last_order_signature: string | null;
        ai_closed_at: Date | null;
        ai_awaiting_payment_at: Date | null;
        ai_active_topic: string | null;
        ai_topic_started_at: Date | null;
        ai_topic_expires_at: Date | null;
        ai_episode_started_at: Date | null;
        ai_linked_order_id: string | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    clear(user: {
        companyId: number;
    }, id: number): Promise<{
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        last_message_at: Date | null;
        pinned_at: Date | null;
        cleared_before: Date | null;
        ai_autoreply: boolean | null;
        ai_order_created_at: Date | null;
        ai_pending_order: import("@prisma/client/runtime/library").JsonValue | null;
        ai_pending_order_at: Date | null;
        ai_last_order_signature: string | null;
        ai_closed_at: Date | null;
        ai_awaiting_payment_at: Date | null;
        ai_active_topic: string | null;
        ai_topic_started_at: Date | null;
        ai_topic_expires_at: Date | null;
        ai_episode_started_at: Date | null;
        ai_linked_order_id: string | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    markRead(user: {
        companyId: number;
        userId: number;
    }, id: number): Promise<{
        ok: boolean;
    }>;
    setAiAutoReply(user: {
        companyId: number;
    }, id: number, body: {
        mode?: string;
    }): Promise<{
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        last_message_at: Date | null;
        pinned_at: Date | null;
        cleared_before: Date | null;
        ai_autoreply: boolean | null;
        ai_order_created_at: Date | null;
        ai_pending_order: import("@prisma/client/runtime/library").JsonValue | null;
        ai_pending_order_at: Date | null;
        ai_last_order_signature: string | null;
        ai_closed_at: Date | null;
        ai_awaiting_payment_at: Date | null;
        ai_active_topic: string | null;
        ai_topic_started_at: Date | null;
        ai_topic_expires_at: Date | null;
        ai_episode_started_at: Date | null;
        ai_linked_order_id: string | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
}
