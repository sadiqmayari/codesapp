import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
export declare class AuthService {
    private readonly prisma;
    private readonly jwt;
    private readonly config;
    private readonly mailer;
    private readonly logger;
    constructor(prisma: PrismaService, jwt: JwtService, config: ConfigService);
    register(dto: RegisterDto): Promise<{
        message: string;
    }>;
    verifyEmail(token: string): Promise<{
        message: string;
    }>;
    login(dto: LoginDto, res: {
        cookie: Function;
    }): Promise<{
        accessToken: string;
        user: {
            id: number;
            name: string;
            email: string;
            role: "agent" | "owner" | "admin";
        };
    }>;
    refresh(refreshToken: string, res: {
        cookie: Function;
    }): Promise<{
        accessToken: string;
        user: {
            id: number;
            name: string;
            email: string;
            role: import(".prisma/client").$Enums.UserRole;
        };
    }>;
    logout(res: {
        clearCookie: Function;
    }): {
        message: string;
    };
    forgotPassword(email: string): Promise<{
        message: string;
    }>;
    resetPassword(token: string, newPassword: string): Promise<{
        message: string;
    }>;
    setup2fa(userId: number): Promise<{
        secret: string;
        message: string;
    }>;
    verify2fa(_userId: number, _code: string): Promise<{
        message: string;
    }>;
    getMe(userId: number): Promise<{
        company: {
            id: number;
            name: string;
            logo_url: string | null;
            activation_status: import(".prisma/client").$Enums.ActivationStatus;
            timezone: string | null;
        } | null;
        status: import(".prisma/client").$Enums.UserStatus;
        created_at: Date;
        id: number;
        name: string;
        company_id: number | null;
        email: string;
        role: import(".prisma/client").$Enums.UserRole;
    }>;
    updateCompanyTimezone(companyId: number, timezone: string | null): Promise<{
        timezone: string | null;
    }>;
    updateProfile(userId: number, name: string): Promise<{
        status: import(".prisma/client").$Enums.UserStatus;
        id: number;
        name: string;
        company_id: number | null;
        email: string;
        role: import(".prisma/client").$Enums.UserRole;
    }>;
    changePassword(userId: number, currentPassword: string, newPassword: string): Promise<{
        message: string;
    }>;
    private send;
    private sendViaResend;
    private sendVerificationEmail;
    private sendPasswordResetEmail;
}
