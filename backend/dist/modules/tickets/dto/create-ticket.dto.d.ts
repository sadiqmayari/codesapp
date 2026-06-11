export declare const TICKET_TYPES: readonly ["refund", "return", "exchange", "damaged", "wrong_item", "missing", "complaint", "other"];
export declare class CreateTicketDto {
    conversationId: number;
    type: string;
    description?: string;
    linkedOrderName?: string;
    assignedUserId?: number;
}
