import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { Verify2faDto } from './dto/verify-2fa.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
export declare class AuthController {
    private readonly authService;
    constructor(authService: AuthService);
    register(dto: RegisterDto): Promise<{
        message: string;
    }>;
    verifyEmail(dto: VerifyEmailDto): Promise<{
        message: string;
    }>;
    login(dto: LoginDto, res: Response): Promise<{
        accessToken: string;
        user: {
            id: number;
            name: string;
            email: string;
            role: "agent" | "owner" | "admin";
        };
    }>;
    refresh(req: Request, res: Response): Promise<{
        accessToken: string;
        user: {
            id: number;
            name: string;
            email: string;
            role: import(".prisma/client").$Enums.UserRole;
        };
    }>;
    logout(res: Response): {
        message: string;
    };
    forgotPassword(dto: ForgotPasswordDto): Promise<{
        message: string;
    }>;
    resetPassword(dto: ResetPasswordDto): Promise<{
        message: string;
    }>;
    me(user: {
        userId: number;
    }): Promise<{
        company: {
            id: number;
            name: string;
            logo_url: string | null;
            activation_status: import(".prisma/client").$Enums.ActivationStatus;
        } | null;
        status: import(".prisma/client").$Enums.UserStatus;
        created_at: Date;
        id: number;
        name: string;
        email: string;
        company_id: number | null;
        role: import(".prisma/client").$Enums.UserRole;
    }>;
    updateProfile(user: {
        userId: number;
    }, dto: UpdateProfileDto): Promise<{
        status: import(".prisma/client").$Enums.UserStatus;
        id: number;
        name: string;
        email: string;
        company_id: number | null;
        role: import(".prisma/client").$Enums.UserRole;
    }>;
    changePassword(user: {
        userId: number;
    }, dto: ChangePasswordDto): Promise<{
        message: string;
    }>;
    setup2fa(user: {
        userId: number;
    }): Promise<{
        secret: string;
        message: string;
    }>;
    verify2fa(user: {
        userId: number;
    }, dto: Verify2faDto): Promise<{
        message: string;
    }>;
}
