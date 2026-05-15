export declare enum BroadcastStatusFilter {
    draft = "draft",
    scheduled = "scheduled",
    sending = "sending",
    completed = "completed",
    failed = "failed",
    cancelled = "cancelled"
}
export declare class ListBroadcastsDto {
    status?: BroadcastStatusFilter;
    page?: number;
    limit?: number;
}
