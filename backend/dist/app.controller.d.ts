import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PrismaService } from './prisma/prisma.service';
export declare class AppController {
    private readonly prisma;
    private readonly config;
    constructor(prisma: PrismaService, config: ConfigService);
    health(): {
        status: string;
        timestamp: string;
    };
    clientIp(req: Request): {
        ip: string | undefined;
        ips: string[];
        xForwardedFor: string | string[] | null;
        remoteAddress: string | null;
    };
    superAdminStatus(): Promise<{
        envEmailSet: boolean;
        envPasswordSet: boolean;
        envEmailLength: number;
        envPasswordLength: number;
        dbReachable: boolean;
        superAdminRowCount: number;
        rowExistsForEnvEmail: boolean;
        role: string | null;
        status: string | null;
        passwordMatchesEnv: boolean;
        error: string | null;
    }>;
}
