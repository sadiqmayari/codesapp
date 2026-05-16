import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma/prisma.service';
export declare class AppController {
    private readonly prisma;
    private readonly config;
    constructor(prisma: PrismaService, config: ConfigService);
    health(): {
        status: string;
        timestamp: string;
    };
    superAdminStatus(): Promise<{
        envEmailSet: boolean;
        envEmailLength: number;
        emailHasSurroundingWhitespace: boolean;
        envPasswordLength: number;
        envPasswordTrimmedLength: number;
        passwordHasSurroundingWhitespace: boolean;
        passwordLooksQuoted: boolean;
        dbReachable: boolean;
        superAdminRowCount: number;
        rowExistsForEnvEmail: boolean;
        role: string | null;
        status: string | null;
        passwordMatchesEnv: boolean;
        passwordMatchesTrimmed: boolean;
        error: string | null;
    }>;
}
