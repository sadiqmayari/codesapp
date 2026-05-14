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
    await this.$connect();

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

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
