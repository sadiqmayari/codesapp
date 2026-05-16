import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
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

    try {
      const existing = await this.prisma.user.findUnique({ where: { email } });

      if (existing) {
        // Env vars are the source of truth for the super-admin credential.
        // Re-sync the password hash so changing SUPER_ADMIN_PASSWORD and
        // redeploying actually takes effect (the old create-only logic left
        // the original hash in place forever → "Invalid credentials").
        const inSync =
          existing.role === 'super_admin' &&
          existing.status === 'active' &&
          (await bcrypt.compare(password, existing.password_hash));
        if (inSync) {
          this.logger.log(`Super admin OK (password in sync): ${email}`);
          return;
        }
        const rehash = await bcrypt.hash(password, 12);
        await this.prisma.user.update({
          where: { id: existing.id },
          data: {
            password_hash: rehash,
            role: 'super_admin',
            status: 'active',
          },
        });
        this.logger.log(`Super admin credential re-synced from env: ${email}`);
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
    } catch (err) {
      this.logger.error(
        `Super admin bootstrap skipped — DB unreachable or table missing: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
