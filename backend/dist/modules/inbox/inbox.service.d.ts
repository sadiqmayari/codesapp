import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageMeteringService } from '../usage-metering/usage-metering.service';
import { InboxGateway } from './inbox.gateway';
import { MetaClientService } from './meta-client.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { SendMessageDto } from './dto/send-message.dto';
import { ListConversationsDto } from './dto/list-conversations.dto';
export declare class InboxService {
    private readonly prisma;
    private readonly metering;
    private readonly gateway;
    private readonly metaClient;
    private readonly config;
    private readonly webhookDispatcher;
    private readonly logger;
    constructor(prisma: PrismaService, metering: UsageMeteringService, gateway: InboxGateway, metaClient: MetaClientService, config: ConfigService, webhookDispatcher: WebhookDispatcherService);
    listConversations(companyId: number, dto: ListConversationsDto): Promise<{
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
            company_id: number;
            updated_at: Date;
            contact_id: number;
            assigned_user_id: number | null;
            last_message: string | null;
            last_message_at: Date | null;
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
    getConversation(companyId: number, id: number): Promise<{
        contact: {
            status: import(".prisma/client").$Enums.ContactStatus;
            created_at: Date;
            id: number;
            name: string;
            email: string | null;
            company_id: number;
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
        company_id: number;
        updated_at: Date;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        last_message_at: Date | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    assign(companyId: number, id: number, userId: number): Promise<{
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        id: number;
        company_id: number;
        updated_at: Date;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        last_message_at: Date | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    setStatus(companyId: number, id: number, status: 'open' | 'resolved' | 'pending'): Promise<{
        status: import(".prisma/client").$Enums.ConversationStatus;
        created_at: Date;
        id: number;
        company_id: number;
        updated_at: Date;
        contact_id: number;
        assigned_user_id: number | null;
        last_message: string | null;
        last_message_at: Date | null;
        window_expires_at: Date | null;
        unread_count: number;
        deleted_at: Date | null;
    }>;
    addLabel(companyId: number, id: number, label: string): Promise<{
        created_at: Date;
        id: number;
        company_id: number;
        conversation_id: number;
        label: string;
    }>;
    removeLabel(companyId: number, id: number, label: string): Promise<{
        removed: boolean;
    }>;
    addNote(companyId: number, id: number, userId: number, body: string): Promise<{
        created_at: Date;
        id: number;
        company_id: number;
        user_id: number;
        conversation_id: number;
        body: string;
    }>;
    listNotes(companyId: number, id: number): Promise<{
        created_at: Date;
        id: number;
        company_id: number;
        user_id: number;
        conversation_id: number;
        body: string;
    }[]>;
    listMessages(companyId: number, id: number, cursor: number | undefined, limit: number): Promise<{
        rows: {
            status: import(".prisma/client").$Enums.MessageStatus;
            created_at: Date;
            id: number;
            company_id: number;
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
    markRead(companyId: number, id: number, userId: number): Promise<{
        ok: boolean;
    }>;
    sendMessage(companyId: number, conversationId: number, dto: SendMessageDto): Promise<{
        status: import(".prisma/client").$Enums.MessageStatus;
        created_at: Date;
        id: number;
        company_id: number;
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
    private buildTemplateComponents;
    private requireConversation;
}
