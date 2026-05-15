export declare enum ConversationListStatus {
    open = "open",
    resolved = "resolved",
    pending = "pending",
    all = "all"
}
export declare class ListConversationsDto {
    status?: ConversationListStatus;
    assignedUserId?: number;
    search?: string;
    label?: string;
    page?: number;
    limit?: number;
}
