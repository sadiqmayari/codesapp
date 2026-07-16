import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions, Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';

/**
 * Socket.io adapter that fans out broadcasts across MULTIPLE app containers via
 * Redis pub/sub. Needed only for horizontal scaling: with a single container the
 * default in-memory adapter is correct and this class is never installed.
 *
 * ── Zero-glitch contract ──────────────────────────────────────────────────
 * This adapter is ONLY wired in when `REDIS_URL` is set (see main.ts). When it
 * is unset — the current production state — nothing here runs and socket.io
 * behaves exactly as it did before (in-memory). So enabling Redis is a pure
 * env flip with no code path change for the existing single-container deploy.
 *
 * ── Isolation ─────────────────────────────────────────────────────────────
 * `REDIS_URL` points at the dedicated `codesapp-redis` container (on the
 * private `codesapp_internal` network only). It is NEVER n8n's Redis — n8n's
 * instance is a separate compose project we must not touch.
 *
 * ── Failure posture ───────────────────────────────────────────────────────
 * ioredis auto-reconnects with backoff. If Redis is briefly unreachable the
 * clients buffer and recover; we log errors instead of crashing the process
 * (the app already installs global unhandledRejection guards). connectToRedis()
 * must be awaited before the server starts accepting connections.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;

  constructor(
    app: INestApplicationContext,
    private readonly redisUrl: string,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    // A pub and a sub connection are required by the socket.io Redis adapter.
    // lazyConnect:false (default) → connect eagerly so a bad URL surfaces now.
    // retryStrategy keeps trying rather than giving up (transient VPS blips).
    const opts = {
      maxRetriesPerRequest: null as null,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
    };
    this.pubClient = new Redis(this.redisUrl, opts);
    this.subClient = this.pubClient.duplicate();

    for (const [name, client] of [
      ['pub', this.pubClient],
      ['sub', this.subClient],
    ] as const) {
      client.on('error', (err) =>
        this.logger.warn(`Redis ${name} client error: ${err.message}`),
      );
    }

    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
    this.logger.log('Socket.io Redis adapter connected (multi-container mode)');
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
