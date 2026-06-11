import { PrismaService } from '../../prisma/prisma.service';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { CreateTicketDto } from './dto/create-ticket.dto';
export declare class TicketsService {
    private readonly prisma;
    constructor(prisma: PrismaService);
    list(companyId: number, opts?: {
        status?: string;
        type?: string;
    }): import(".prisma/client").Prisma.PrismaPromise<({
        contact: {
            id: number;
            name: string;
            phone: string;
        };
        assigned_user: {
            id: number;
            name: string;
        } | null;
    } & {
        status: string;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        type: string;
        contact_id: number;
        assigned_user_id: number | null;
        conversation_id: number;
        description: string | null;
        resolution_note: string | null;
        ticket_number: string;
        linked_order_name: string | null;
        created_by: string;
        closed_at: Date | null;
    })[]>;
    get(companyId: number, id: number): Promise<{
        contact: {
            id: number;
            name: string;
            phone: string;
        };
        events: {
            created_at: Date;
            id: number;
            company_id: number;
            user_id: number | null;
            body: string | null;
            kind: string;
            actor: string;
            ticket_id: number;
        }[];
        assigned_user: {
            id: number;
            name: string;
        } | null;
    } & {
        status: string;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        type: string;
        contact_id: number;
        assigned_user_id: number | null;
        conversation_id: number;
        description: string | null;
        resolution_note: string | null;
        ticket_number: string;
        linked_order_name: string | null;
        created_by: string;
        closed_at: Date | null;
    }>;
    findOpenForConversation(companyId: number, conversationId: number): import(".prisma/client").Prisma.Prisma__SupportTicketClient<{
        status: string;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        type: string;
        contact_id: number;
        assigned_user_id: number | null;
        conversation_id: number;
        description: string | null;
        resolution_note: string | null;
        ticket_number: string;
        linked_order_name: string | null;
        created_by: string;
        closed_at: Date | null;
    } | null, null, import("@prisma/client/runtime/library").DefaultArgs>;
    createOrReuseForConversation(companyId: number, input: {
        conversationId: number;
        contactId: number;
        type: string;
        createdBy: 'ai' | 'agent';
        description?: string;
    }): Promise<{
        ticket: {
            id: number;
            ticket_number: string;
            status: string;
        };
        created: boolean;
    }>;
    addEvent(companyId: number, ticketId: number, e: {
        kind: string;
        actor: 'ai' | 'agent' | 'customer';
        body?: string | null;
        userId?: number | null;
    }): Promise<{
        created_at: Date;
        id: number;
        company_id: number;
        user_id: number | null;
        body: string | null;
        kind: string;
        actor: string;
        ticket_id: number;
    }>;
    update(companyId: number, id: number, dto: UpdateTicketDto, userId: number): Promise<{
        contact: {
            id: number;
            name: string;
            phone: string;
        };
        events: {
            created_at: Date;
            id: number;
            company_id: number;
            user_id: number | null;
            body: string | null;
            kind: string;
            actor: string;
            ticket_id: number;
        }[];
        assigned_user: {
            id: number;
            name: string;
        } | null;
    } & {
        status: string;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        type: string;
        contact_id: number;
        assigned_user_id: number | null;
        conversation_id: number;
        description: string | null;
        resolution_note: string | null;
        ticket_number: string;
        linked_order_name: string | null;
        created_by: string;
        closed_at: Date | null;
    }>;
    addNote(companyId: number, id: number, body: string, userId: number): Promise<{
        contact: {
            id: number;
            name: string;
            phone: string;
        };
        events: {
            created_at: Date;
            id: number;
            company_id: number;
            user_id: number | null;
            body: string | null;
            kind: string;
            actor: string;
            ticket_id: number;
        }[];
        assigned_user: {
            id: number;
            name: string;
        } | null;
    } & {
        status: string;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        type: string;
        contact_id: number;
        assigned_user_id: number | null;
        conversation_id: number;
        description: string | null;
        resolution_note: string | null;
        ticket_number: string;
        linked_order_name: string | null;
        created_by: string;
        closed_at: Date | null;
    }>;
    createManual(companyId: number, userId: number, dto: CreateTicketDto): Promise<{
        contact: {
            id: number;
            name: string;
            phone: string;
        };
        events: {
            created_at: Date;
            id: number;
            company_id: number;
            user_id: number | null;
            body: string | null;
            kind: string;
            actor: string;
            ticket_id: number;
        }[];
        assigned_user: {
            id: number;
            name: string;
        } | null;
    } & {
        status: string;
        created_at: Date;
        id: number;
        updated_at: Date;
        company_id: number;
        type: string;
        contact_id: number;
        assigned_user_id: number | null;
        conversation_id: number;
        description: string | null;
        resolution_note: string | null;
        ticket_number: string;
        linked_order_name: string | null;
        created_by: string;
        closed_at: Date | null;
    }>;
    private nextTicketNumber;
}
