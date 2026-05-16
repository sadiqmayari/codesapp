export declare class ListLogsDto {
    endpointId?: number;
    event?: string;
    status?: 'pending' | 'success' | 'failed';
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
}
