import { TicketsService } from './tickets.service';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { CreateTicketEventDto } from './dto/create-ticket-event.dto';
export declare class TicketsController {
    private readonly tickets;
    constructor(tickets: TicketsService);
    list(user: {
        companyId: number;
    }, status?: string, type?: string): import(".prisma/client").Prisma.PrismaPromise<({
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
        ticket_number: string;
        linked_order_name: string | null;
        created_by: string;
        resolution_note: string | null;
        closed_at: Date | null;
    })[]>;
    openForConversation(user: {
        companyId: number;
    }, conversationId: number): import(".prisma/client").Prisma.Prisma__SupportTicketClient<{
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
        ticket_number: string;
        linked_order_name: string | null;
        created_by: string;
        resolution_note: string | null;
        closed_at: Date | null;
    } | null, null, import("@prisma/client/runtime/library").DefaultArgs>;
    get(user: {
        companyId: number;
    }, id: number): Promise<{
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
        ticket_number: string;
        linked_order_name: string | null;
        created_by: string;
        resolution_note: string | null;
        closed_at: Date | null;
    }>;
    update(user: {
        companyId: number;
        userId: number;
    }, id: number, dto: UpdateTicketDto): Promise<{
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
        ticket_number: string;
        linked_order_name: string | null;
        created_by: string;
        resolution_note: string | null;
        closed_at: Date | null;
    }>;
    addNote(user: {
        companyId: number;
        userId: number;
    }, id: number, dto: CreateTicketEventDto): Promise<{
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
        ticket_number: string;
        linked_order_name: string | null;
        created_by: string;
        resolution_note: string | null;
        closed_at: Date | null;
    }>;
}
