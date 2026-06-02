import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly isDev: boolean;

  constructor(config: ConfigService) {
    super({
      log:
        config.get('NODE_ENV') === 'development'
          ? ['warn', 'error']
          : ['error'],
    });
    this.isDev = config.get('NODE_ENV') === 'development';
  }

  async onModuleInit() {
    // Don't crash the app if DB is unreachable — log and keep running
    // so /health still responds and we can diagnose env vars
    try {
      await this.$connect();
      this.logger.log('Prisma connected to database');
      // Force the connection charset to utf8mb4 so 4-byte characters (emoji,
      // many CJK/symbol glyphs, WhatsApp sticker text) are stored intact.
      // The columns + server are already utf8mb4, but on some MySQL/MariaDB
      // hosts (e.g. Hostinger) Prisma's connection negotiates a narrower
      // client charset (latin1/utf8mb3), which silently replaces every
      // unrepresentable codepoint with '?' on INSERT. We run connection_limit=1
      // and the job poller keeps the single connection alive permanently, so
      // this one-shot SET NAMES persists for the whole process lifetime.
      await this.ensureUtf8mb4();
    } catch (err) {
      this.logger.error(
        `Prisma failed to connect — app will start anyway: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (this.isDev) {
      // Log slow queries (>500ms) in development
      this.$use(async (params, next) => {
        const start = Date.now();
        const result = await next(params);
        const duration = Date.now() - start;

        if (duration > 500) {
          this.logger.warn(
            `Slow query [${params.model}.${params.action}] ${duration}ms`,
          );
        }

        return result;
      });
    }
  }

  /**
   * Pin the connection to utf8mb4 and log the negotiated charset so the fix
   * is verifiable from the boot logs. Never throws — a failure here must not
   * stop the app from starting.
   */
  private async ensureUtf8mb4(): Promise<void> {
    try {
      await this.$executeRawUnsafe(
        'SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci',
      );
      const vars = await this.$queryRawUnsafe<
        Array<{ Variable_name: string; Value: string }>
      >("SHOW VARIABLES LIKE 'character_set_client'");
      const client = vars?.[0]?.Value ?? 'unknown';
      this.logger.log(`DB connection charset (character_set_client): ${client}`);
    } catch (err) {
      this.logger.warn(
        `Could not set connection charset to utf8mb4: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
