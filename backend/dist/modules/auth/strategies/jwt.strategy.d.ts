import { ConfigService } from '@nestjs/config';
import { Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';
export interface JwtPayload {
    sub: number;
    companyId: number | null;
    role: string;
    email: string;
}
declare const JwtStrategy_base: new (...args: any[]) => Strategy;
export declare class JwtStrategy extends JwtStrategy_base {
    private readonly prisma;
    constructor(config: ConfigService, prisma: PrismaService);
    validate(payload: JwtPayload): Promise<{
        userId: number;
        companyId: number | null;
        role: import(".prisma/client").$Enums.UserRole;
        email: string;
    }>;
}
export {};
