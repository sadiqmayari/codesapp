export declare class AppController {
    health(): {
        resourceBreakdown?: Record<string, number> | undefined;
        status: string;
        timestamp: string;
        pid: number;
        bootId: string;
        bootAt: string;
        uptimeSec: number;
        memoryMb: {
            rss: number;
            heapUsed: number;
            heapTotal: number;
            external: number;
            arrayBuffers: number;
        };
        activeResources: string | number;
    };
}
