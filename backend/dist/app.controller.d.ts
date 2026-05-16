import { Request } from 'express';
export declare class AppController {
    health(): {
        status: string;
        timestamp: string;
    };
    clientIp(req: Request): {
        ip: string | undefined;
        ips: string[];
        xForwardedFor: string | string[] | null;
        remoteAddress: string | null;
        hint: string;
    };
}
