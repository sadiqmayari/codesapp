"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const bcrypt = require("bcryptjs");
const uuid_1 = require("uuid");
const nodemailer = require("nodemailer");
const prisma_service_1 = require("../../prisma/prisma.service");
const BCRYPT_ROUNDS = 12;
let AuthService = class AuthService {
    constructor(prisma, jwt, config) {
        this.prisma = prisma;
        this.jwt = jwt;
        this.config = config;
        this.mailer = nodemailer.createTransport({
            host: this.config.get('SMTP_HOST'),
            port: Number(this.config.get('SMTP_PORT') ?? 587),
            auth: {
                user: this.config.get('SMTP_USER'),
                pass: this.config.get('SMTP_PASS'),
            },
        });
    }
    async register(dto) {
        const existing = await this.prisma.user.findUnique({
            where: { email: dto.email },
        });
        if (existing)
            throw new common_1.ConflictException('Email already registered');
        let subscription = await this.prisma.subscription.findFirst({
            where: { plan_name: 'starter' },
        });
        if (!subscription) {
            subscription = await this.prisma.subscription.create({
                data: {
                    plan_name: 'starter',
                    contact_limit: 500,
                    template_limit: 10,
                    user_limit: 3,
                    monthly_price: 0,
                    setup_fee: 0,
                },
            });
        }
        const hash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
        const verifyToken = (0, uuid_1.v4)();
        const company = await this.prisma.company.create({
            data: {
                company_name: dto.companyName,
                address: dto.address,
                subscription_id: subscription.id,
                activation_status: 'pending',
                onboarding_status: { completed: false },
            },
        });
        await this.prisma.user.create({
            data: {
                company_id: company.id,
                name: dto.name,
                email: dto.email,
                password_hash: hash,
                role: 'owner',
                status: 'pending',
                totp_secret: verifyToken,
            },
        });
        await this.sendVerificationEmail(dto.email, dto.name, verifyToken);
        return { message: 'Registration successful. Check your email to verify your account.' };
    }
    async verifyEmail(token) {
        const user = await this.prisma.user.findFirst({
            where: { totp_secret: token, status: 'pending' },
        });
        if (!user)
            throw new common_1.BadRequestException('Invalid or expired verification token');
        await this.prisma.user.update({
            where: { id: user.id },
            data: { totp_secret: null, status: 'pending' },
        });
        return { message: 'Email verified. Your account is pending admin approval.' };
    }
    async login(dto, res) {
        const user = await this.prisma.user.findUnique({
            where: { email: dto.email },
            include: { company: true },
        });
        if (!user)
            throw new common_1.UnauthorizedException('Invalid credentials');
        const valid = await bcrypt.compare(dto.password, user.password_hash);
        if (!valid)
            throw new common_1.UnauthorizedException('Invalid credentials');
        if (user.status !== 'active') {
            throw new common_1.UnauthorizedException('Account not active. Contact support.');
        }
        const payload = {
            sub: user.id,
            companyId: user.company_id,
            role: user.role,
            email: user.email,
        };
        const accessToken = this.jwt.sign(payload, {
            secret: this.config.get('JWT_SECRET'),
            expiresIn: this.config.get('JWT_EXPIRES_IN') ?? '15m',
        });
        const refreshToken = this.jwt.sign(payload, {
            secret: this.config.get('JWT_REFRESH_SECRET'),
            expiresIn: this.config.get('JWT_REFRESH_EXPIRES_IN') ?? '7d',
        });
        res.cookie('refresh_token', refreshToken, {
            httpOnly: true,
            secure: this.config.get('NODE_ENV') === 'production',
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            path: '/',
        });
        return { accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
    }
    async refresh(refreshToken, res) {
        let payload;
        try {
            payload = this.jwt.verify(refreshToken, {
                secret: this.config.get('JWT_REFRESH_SECRET'),
            });
        }
        catch {
            throw new common_1.UnauthorizedException('Invalid refresh token');
        }
        const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
        if (!user || user.status !== 'active')
            throw new common_1.UnauthorizedException();
        const newPayload = {
            sub: user.id,
            companyId: user.company_id,
            role: user.role,
            email: user.email,
        };
        const accessToken = this.jwt.sign(newPayload, {
            secret: this.config.get('JWT_SECRET'),
            expiresIn: this.config.get('JWT_EXPIRES_IN') ?? '15m',
        });
        const newRefresh = this.jwt.sign(newPayload, {
            secret: this.config.get('JWT_REFRESH_SECRET'),
            expiresIn: this.config.get('JWT_REFRESH_EXPIRES_IN') ?? '7d',
        });
        res.cookie('refresh_token', newRefresh, {
            httpOnly: true,
            secure: this.config.get('NODE_ENV') === 'production',
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            path: '/',
        });
        return { accessToken };
    }
    logout(res) {
        res.clearCookie('refresh_token', { path: '/' });
        return { message: 'Logged out' };
    }
    async forgotPassword(email) {
        const user = await this.prisma.user.findUnique({ where: { email } });
        if (!user)
            return { message: 'If that email exists, a reset link has been sent.' };
        const token = (0, uuid_1.v4)();
        await this.prisma.user.update({
            where: { id: user.id },
            data: { totp_secret: `reset:${token}` },
        });
        await this.sendPasswordResetEmail(email, user.name, token);
        return { message: 'If that email exists, a reset link has been sent.' };
    }
    async resetPassword(token, newPassword) {
        const user = await this.prisma.user.findFirst({
            where: { totp_secret: `reset:${token}` },
        });
        if (!user)
            throw new common_1.BadRequestException('Invalid or expired reset token');
        const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
        await this.prisma.user.update({
            where: { id: user.id },
            data: { password_hash: hash, totp_secret: null },
        });
        return { message: 'Password reset successfully' };
    }
    async setup2fa(userId) {
        const secret = (0, uuid_1.v4)();
        await this.prisma.user.update({
            where: { id: userId },
            data: { totp_secret: secret },
        });
        return { secret, message: '2FA setup initiated (full TOTP enforcement in Phase 2)' };
    }
    async verify2fa(_userId, _code) {
        return { message: '2FA verify scaffold — not enforced in v1' };
    }
    async sendVerificationEmail(email, name, token) {
        const appUrl = this.config.get('APP_URL') ?? 'http://localhost:3000';
        const link = `${appUrl}/verify-email?token=${token}`;
        await this.mailer.sendMail({
            from: this.config.get('SMTP_FROM'),
            to: email,
            subject: 'Verify your CodesApp account',
            html: `
        <h2>Hello ${name},</h2>
        <p>Thanks for registering with CodesApp. Please verify your email address:</p>
        <p><a href="${link}" style="background:#25D366;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;">Verify Email</a></p>
        <p>Or copy this link: ${link}</p>
        <p>This link is valid for 24 hours.</p>
      `,
        }).catch(() => { });
    }
    async sendPasswordResetEmail(email, name, token) {
        const appUrl = this.config.get('APP_URL') ?? 'http://localhost:3000';
        const link = `${appUrl}/reset-password?token=${token}`;
        await this.mailer.sendMail({
            from: this.config.get('SMTP_FROM'),
            to: email,
            subject: 'Reset your CodesApp password',
            html: `
        <h2>Hello ${name},</h2>
        <p>You requested a password reset. Click the link below:</p>
        <p><a href="${link}" style="background:#25D366;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;">Reset Password</a></p>
        <p>Or copy this link: ${link}</p>
        <p>This link expires in 1 hour.</p>
      `,
        }).catch(() => { });
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        jwt_1.JwtService,
        config_1.ConfigService])
], AuthService);
//# sourceMappingURL=auth.service.js.map