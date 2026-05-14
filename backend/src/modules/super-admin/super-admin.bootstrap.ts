import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SuperAdminBootstrap implements OnModuleInit {
  private readonly logger = new Logger(SuperAdminBootstrap.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    const email = this.config.get<string>('SUPER_ADMIN_EMAIL');
    const password = this.config.get<string>('SUPER_ADMIN_PASSWORD');

    if (!email || !password) {
      this.logger.warn('SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD not set — skipping bootstrap');
      return;
    }

    const existing = await this.prisma.user
      .findUnique({ where: { email } })
      .catch(() => null);

    if (existing) {
      this.logger.log(`Super admin already exists: ${email}`);
      return;
    }

    const hash = await bcrypt.hash(password, 12);

    await this.prisma.user.create({
      data: {
        company_id: null,
        name: 'Super Admin',
        email,
        password_hash: hash,
        role: 'super_admin',
        status: 'active',
      },
    });

    this.logger.log(`Super admin bootstrapped: ${email}`);
  }
}
