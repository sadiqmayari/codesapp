export declare const TICKET_STATUSES: readonly ["open", "in_progress", "awaiting_customer", "resolved", "rejected"];
export declare class UpdateTicketDto {
    status?: string;
    assignedUserId?: number | null;
    resolutionNote?: string;
}
