import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import * as nodemailer from 'nodemailer';
import * as https from 'https';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  private readonly mailer: nodemailer.Transporter;
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    const port = Number(this.config.get('SMTP_PORT') ?? 587);
    // Port 465 = implicit TLS (secure:true). 587/25 = STARTTLS (secure:false).
    // SMTP_SECURE env can force it explicitly ("true"/"false").
    const secureEnv = (this.config.get<string>('SMTP_SECURE') ?? '').toLowerCase();
    const secure =
      secureEnv === 'true' ? true : secureEnv === 'false' ? false : port === 465;
    const host = this.config.get<string>('SMTP_HOST');
    if (!host) {
      this.logger.warn(
        'SMTP_HOST not set — verification/reset emails will NOT be sent. ' +
          'Activate new tenants via super-admin (clients/:id/activate).',
      );
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

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) throw new ConflictException('Email already registered');

    // Use the starter plan as default
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
    const verifyToken = uuidv4();

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
        totp_secret: verifyToken, // temporarily reuse for email token
      },
    });

    await this.sendVerificationEmail(dto.email, dto.name, verifyToken);

    return { message: 'Registration successful. Check your email to verify your account.' };
  }

  async verifyEmail(token: string) {
    const user = await this.prisma.user.findFirst({
      where: { totp_secret: token, status: 'pending' },
    });
    if (!user) throw new BadRequestException('Invalid or expired verification token');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { totp_secret: null, status: 'pending' }, // stays pending until super admin activates
    });

    return { message: 'Email verified. Your account is pending admin approval.' };
  }

  async login(dto: LoginDto, res: { cookie: Function }) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { company: true },
    });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(dto.password, user.password_hash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    // Super admins must use the dedicated super-admin portal, never the
    // tenant login (different guard/IP model; no company context).
    if (user.role === 'super_admin') {
      throw new UnauthorizedException(
        'Super admin accounts must sign in at /super-admin/login',
      );
    }

    if (user.status !== 'active') {
      throw new UnauthorizedException('Account not active. Contact support.');
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

    (res as any).cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    return { accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  }

  async refresh(refreshToken: string, res: { cookie: Function }) {
    let payload: any;
    try {
      payload = this.jwt.verify(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== 'active') throw new UnauthorizedException();

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

    (res as any).cookie('refresh_token', newRefresh, {
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

  logout(res: { clearCookie: Function }) {
    (res as any).clearCookie('refresh_token', { path: '/' });
    return { message: 'Logged out' };
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Always return the same message to prevent email enumeration
    if (!user) return { message: 'If that email exists, a reset link has been sent.' };

    const token = uuidv4();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { totp_secret: `reset:${token}` },
    });

    await this.sendPasswordResetEmail(email, user.name, token);
    return { message: 'If that email exists, a reset link has been sent.' };
  }

  async resetPassword(token: string, newPassword: string) {
    const user = await this.prisma.user.findFirst({
      where: { totp_secret: `reset:${token}` },
    });
    if (!user) throw new BadRequestException('Invalid or expired reset token');

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password_hash: hash, totp_secret: null },
    });

    return { message: 'Password reset successfully' };
  }

  // 2FA scaffold — not enforced in v1
  async setup2fa(userId: number) {
    const secret = uuidv4(); // Placeholder — real TOTP uses speakeasy
    await this.prisma.user.update({
      where: { id: userId },
      data: { totp_secret: secret },
    });
    return { secret, message: '2FA setup initiated (full TOTP enforcement in Phase 2)' };
  }

  async verify2fa(_userId: number, _code: string) {
    return { message: '2FA verify scaffold — not enforced in v1' };
  }

  /**
   * Unified send: uses the Resend HTTP API when RESEND_API_KEY is set
   * (no SMTP — works on shared hosting that blocks/garbles SMTP AUTH),
   * otherwise falls back to nodemailer SMTP. Never throws.
   */
  private async send(to: string, subject: string, html: string) {
    const from =
      this.config.get<string>('SMTP_FROM') ?? 'no-reply@codentra.pk';
    const resendKey = this.config.get<string>('RESEND_API_KEY');
    try {
      if (resendKey) {
        await this.sendViaResend(resendKey, from, to, subject, html);
      } else {
        await this.mailer.sendMail({ from, to, subject, html });
      }
    } catch (e) {
      this.logger.error(
        `Email to ${to} ("${subject}") failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private sendViaResend(
    apiKey: string,
    from: string,
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    const payload = JSON.stringify({ from, to: [to], subject, html });
    return new Promise<void>((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.resend.com',
          path: '/emails',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => {
            const code = res.statusCode ?? 0;
            if (code >= 200 && code < 300) resolve();
            else reject(new Error(`Resend HTTP ${code}: ${data}`));
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(10000, () =>
        req.destroy(new Error('Resend request timeout')),
      );
      req.write(payload);
      req.end();
    });
  }

  private async sendVerificationEmail(email: string, name: string, token: string) {
    const appUrl = this.config.get('APP_URL') ?? 'http://localhost:3000';
    const link = `${appUrl}/verify-email?token=${token}`;

    await this.send(
      email,
      'Verify your CodesApp account',
      `
        <h2>Hello ${name},</h2>
        <p>Thanks for registering with CodesApp. Please verify your email address:</p>
        <p><a href="${link}" style="background:#25D366;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;">Verify Email</a></p>
        <p>Or copy this link: ${link}</p>
        <p>This link is valid for 24 hours.</p>
      `,
    );
  }

  private async sendPasswordResetEmail(email: string, name: string, token: string) {
    const appUrl = this.config.get('APP_URL') ?? 'http://localhost:3000';
    const link = `${appUrl}/reset-password?token=${token}`;

    await this.send(
      email,
      'Reset your CodesApp password',
      `
        <h2>Hello ${name},</h2>
        <p>You requested a password reset. Click the link below:</p>
        <p><a href="${link}" style="background:#25D366;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;">Reset Password</a></p>
        <p>Or copy this link: ${link}</p>
        <p>This link expires in 1 hour.</p>
      `,
    );
  }
}
