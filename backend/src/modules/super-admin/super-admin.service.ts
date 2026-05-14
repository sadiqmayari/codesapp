import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SuperAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string, res: any) {
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || user.role !== 'super_admin') {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new UnauthorizedException('Invalid credentials');

    const payload = {
      sub: user.id,
      companyId: null,
      role: 'super_admin',
      email: user.email,
    };

    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get('JWT_SECRET'),
      expiresIn: '2h',
    });

    const refreshToken = this.jwt.sign(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: '1d',
    });

    res.cookie('sa_refresh_token', refreshToken, {
      httpOnly: true,
      secure: this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/',
    });

    return { accessToken };
  }

  async getDashboard() {
    const [totalCompanies, totalUsers, pendingCompanies] = await Promise.all([
      this.prisma.company.count(),
      this.prisma.user.count({ where: { role: { not: 'super_admin' } } }),
      this.prisma.company.count({ where: { activation_status: 'pending' } }),
    ]);

    return { totalCompanies, totalUsers, pendingCompanies };
  }

  async getClients(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.company.findMany({
        skip,
        take: limit,
        include: { subscription: true },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.company.count(),
    ]);

    return { items, meta: { page, limit, total } };
  }

  async getClient(id: number) {
    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        subscription: true,
        users: { select: { id: true, name: true, email: true, role: true, status: true } },
      },
    });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }

  async activateClient(id: number) {
    return this.prisma.$transaction(async (tx) => {
      const company = await tx.company.update({
        where: { id },
        data: { activation_status: 'active' },
      });

      // Activate the owner user
      await tx.user.updateMany({
        where: { company_id: id, role: 'owner' },
        data: { status: 'active' },
      });

      return company;
    });
  }

  async suspendClient(id: number) {
    return this.prisma.company.update({
      where: { id },
      data: { activation_status: 'suspended' },
    });
  }

  async deleteClient(id: number) {
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Company not found');

    // Cascade via Prisma relations — order matters due to FKs
    await this.prisma.$transaction([
      this.prisma.message.deleteMany({ where: { company_id: id } }),
      this.prisma.conversation.deleteMany({ where: { company_id: id } }),
      this.prisma.contact.deleteMany({ where: { company_id: id } }),
      this.prisma.template.deleteMany({ where: { company_id: id } }),
      this.prisma.bot.deleteMany({ where: { company_id: id } }),
      this.prisma.broadcast.deleteMany({ where: { company_id: id } }),
      this.prisma.webhookLog.deleteMany({ where: { company_id: id } }),
      this.prisma.webhookEndpoint.deleteMany({ where: { company_id: id } }),
      this.prisma.invoice.deleteMany({ where: { company_id: id } }),
      this.prisma.auditLog.deleteMany({ where: { company_id: id } }),
      this.prisma.usageMetering.deleteMany({ where: { company_id: id } }),
      this.prisma.shopifyIntegration.deleteMany({ where: { company_id: id } }),
      this.prisma.user.deleteMany({ where: { company_id: id } }),
      this.prisma.company.delete({ where: { id } }),
    ]);

    return { message: 'Company deleted' };
  }

  async getPlans() {
    return this.prisma.subscription.findMany();
  }

  async createPlan(data: {
    plan_name: string;
    contact_limit: number;
    template_limit: number;
    user_limit: number;
    monthly_price: number;
    setup_fee: number;
    webhook_enabled?: boolean;
  }) {
    return this.prisma.subscription.create({ data });
  }

  async updatePlan(id: number, data: Partial<ReturnType<typeof this.createPlan>>) {
    return this.prisma.subscription.update({ where: { id }, data: data as any });
  }

  async getInvoices(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.invoice.findMany({
        skip,
        take: limit,
        include: { company: { select: { company_name: true } } },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.invoice.count(),
    ]);
    return { items, meta: { page, limit, total } };
  }

  async getUsage() {
    const period = new Date().toISOString().slice(0, 7);
    return this.prisma.usageMetering.findMany({
      where: { period },
      include: { company: { select: { company_name: true, subscription: true } } },
    });
  }

  async getAuditLogs(page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        skip,
        take: limit,
        include: { user: { select: { name: true, email: true } } },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.auditLog.count(),
    ]);
    return { items, meta: { page, limit, total } };
  }

  async impersonate(companyId: number, actingAdminId: number) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: { users: { where: { role: 'owner' }, take: 1 } },
    });
    if (!company) throw new NotFoundException('Company not found');

    const owner = company.users[0];
    const payload = {
      sub: owner.id,
      companyId,
      role: owner.role,
      email: owner.email,
      impersonated: true,
    };

    // Audit log
    await this.prisma.auditLog.create({
      data: {
        user_id: actingAdminId,
        company_id: null,
        action: 'super_admin.impersonate',
        entity: 'company',
        entity_id: companyId,
        metadata: { targetCompanyId: companyId },
      },
    });

    const token = this.jwt.sign(payload, {
      secret: this.config.get('JWT_SECRET'),
      expiresIn: '1h',
    });

    return { impersonationToken: token };
  }
}
