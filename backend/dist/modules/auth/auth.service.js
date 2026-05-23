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
var AuthService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const jwt_1 = require("@nestjs/jwt");
const bcrypt = require("bcryptjs");
const uuid_1 = require("uuid");
const nodemailer = require("nodemailer");
const https = require("https");
const prisma_service_1 = require("../../prisma/prisma.service");
const BCRYPT_ROUNDS = 12;
let AuthService = AuthService_1 = class AuthService {
    constructor(prisma, jwt, config) {
        this.prisma = prisma;
        this.jwt = jwt;
        this.config = config;
        this.logger = new common_1.Logger(AuthService_1.name);
        const port = Number(this.config.get('SMTP_PORT') ?? 587);
        const secureEnv = (this.config.get('SMTP_SECURE') ?? '').toLowerCase();
        const secure = secureEnv === 'true' ? true : secureEnv === 'false' ? false : port === 465;
        const host = this.config.get('SMTP_HOST');
        if (!host) {
            this.logger.warn('SMTP_HOST not set — verification/reset emails will NOT be sent. ' +
                'Activate new tenants via super-admin (clients/:id/activate).');
        }
        this.mailer = nodemailer.createTransport({
            host,
            port,
            secure,
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
        if (user.role === 'super_admin') {
            throw new common_1.UnauthorizedException('Super admin accounts must sign in at /super-admin/login');
        }
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
            expiresIn: this.config.get('JWT_EXPIRES_IN') ?? '7d',
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
            expiresIn: this.config.get('JWT_EXPIRES_IN') ?? '7d',
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
        return {
            accessToken,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
            },
        };
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
    async getMe(userId) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                status: true,
                company_id: true,
                created_at: true,
                company: {
                    select: {
                        id: true,
                        company_name: true,
                        logo_url: true,
                        activation_status: true,
                        timezone: true,
                    },
                },
            },
        });
        if (!user)
            throw new common_1.NotFoundException('User not found');
        const { company, ...rest } = user;
        return {
            ...rest,
            company: company
                ? {
                    id: company.id,
                    name: company.company_name,
                    logo_url: company.logo_url,
                    activation_status: company.activation_status,
                    timezone: company.timezone,
                }
                : null,
        };
    }
    async updateCompanyTimezone(companyId, timezone) {
        if (timezone !== null) {
            const tz = timezone.trim();
            if (!tz) {
                throw new common_1.BadRequestException('Timezone cannot be empty');
            }
            try {
                new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
            }
            catch {
                throw new common_1.BadRequestException(`Invalid IANA timezone name: "${tz}". Use e.g. "Asia/Karachi".`);
            }
            timezone = tz;
        }
        await this.prisma.company.update({
            where: { id: companyId },
            data: { timezone },
        });
        return { timezone };
    }
    async updateProfile(userId, name) {
        const trimmed = name.trim();
        if (trimmed.length < 2) {
            throw new common_1.BadRequestException('Name must be at least 2 characters');
        }
        const user = await this.prisma.user.update({
            where: { id: userId },
            data: { name: trimmed },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                status: true,
                company_id: true,
            },
        });
        return user;
    }
    async changePassword(userId, currentPassword, newPassword) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user)
            throw new common_1.NotFoundException('User not found');
        const ok = await bcrypt.compare(currentPassword, user.password_hash);
        if (!ok)
            throw new common_1.BadRequestException('Current password is incorrect');
        if (newPassword.length < 8) {
            throw new common_1.BadRequestException('New password must be at least 8 characters');
        }
        const password_hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
        await this.prisma.user.update({
            where: { id: userId },
            data: { password_hash },
        });
        return { message: 'Password changed' };
    }
    async send(to, subject, html) {
        const from = this.config.get('SMTP_FROM') ?? 'no-reply@codentra.pk';
        const resendKey = this.config.get('RESEND_API_KEY');
        try {
            if (resendKey) {
                await this.sendViaResend(resendKey, from, to, subject, html);
            }
            else {
                await this.mailer.sendMail({ from, to, subject, html });
            }
        }
        catch (e) {
            this.logger.error(`Email to ${to} ("${subject}") failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    sendViaResend(apiKey, from, to, subject, html) {
        const payload = JSON.stringify({ from, to: [to], subject, html });
        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.resend.com',
                path: '/emails',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Length': Buffer.byteLength(payload),
                },
            }, (res) => {
                let data = '';
                res.on('data', (d) => (data += d));
                res.on('end', () => {
                    const code = res.statusCode ?? 0;
                    if (code >= 200 && code < 300)
                        resolve();
                    else
                        reject(new Error(`Resend HTTP ${code}: ${data}`));
                });
            });
            req.on('error', reject);
            req.setTimeout(10000, () => req.destroy(new Error('Resend request timeout')));
            req.write(payload);
            req.end();
        });
    }
    async sendVerificationEmail(email, name, token) {
        const appUrl = this.config.get('APP_URL') ?? 'http://localhost:3000';
        const link = `${appUrl}/verify-email?token=${token}`;
        await this.send(email, 'Verify your CodesApp account', `
        <h2>Hello ${name},</h2>
        <p>Thanks for registering with CodesApp. Please verify your email address:</p>
        <p><a href="${link}" style="background:#25D366;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;">Verify Email</a></p>
        <p>Or copy this link: ${link}</p>
        <p>This link is valid for 24 hours.</p>
      `);
    }
    async sendPasswordResetEmail(email, name, token) {
        const appUrl = this.config.get('APP_URL') ?? 'http://localhost:3000';
        const link = `${appUrl}/reset-password?token=${token}`;
        await this.send(email, 'Reset your CodesApp password', `
        <h2>Hello ${name},</h2>
        <p>You requested a password reset. Click the link below:</p>
        <p><a href="${link}" style="background:#25D366;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;">Reset Password</a></p>
        <p>Or copy this link: ${link}</p>
        <p>This link expires in 1 hour.</p>
      `);
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = AuthService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        jwt_1.JwtService,
        config_1.ConfigService])
], AuthService);
//# sourceMappingURL=auth.service.js.map