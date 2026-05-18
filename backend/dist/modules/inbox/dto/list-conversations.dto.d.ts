export declare enum ConversationListStatus {
    open = "open",
    resolved = "resolved",
    pending = "pending",
    unread = "unread",
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
