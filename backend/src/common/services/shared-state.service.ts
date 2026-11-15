import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

/**
 * Small JSON key/value store that BOTH prod containers can see (web + worker,
 * see process-role.ts). Backed by Redis when `REDIS_URL` is set; otherwise an
 * in-process map (local dev / single `all` process — same as before).
 *
 * Use it for short-lived progress a web request starts and a worker job
 * updates (e.g. bulk-cancel progress). An in-process `Map` breaks there: the
 * worker writes its own copy and the web poll never sees it. Never throws —
 * a Redis hiccup falls back to the local map for that call.
 */
@Injectable()
export class SharedStateService implements OnModuleDestroy {
  private readonly logger = new Logger(SharedStateService.name);
  private readonly redis: Redis | null = null;
  private readonly mem = new Map<string, { v: string; exp: number }>();

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) return;
    try {
      this.redis = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: false });
      this.redis.on('error', () => undefined);
    } catch (e) {
      this.logger.warn(`Shared state falls back to memory: ${(e as Error).message}`);
      this.redis = null;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    let raw: string | null = null;
    if (this.redis) {
      try {
        raw = await this.redis.get(`ss:${key}`);
      } catch {
        raw = null;
      }
    }
    if (raw == null) {
      const hit = this.mem.get(key);
      if (hit && hit.exp > Date.now()) raw = hit.v;
      else if (hit) this.mem.delete(key);
    }
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const v = JSON.stringify(value);
    if (this.redis) {
      try {
        await this.redis.set(`ss:${key}`, v, 'EX', Math.max(1, Math.round(ttlSeconds)));
        return;
      } catch {
        /* fall through to memory */
      }
    }
    this.mem.set(key, { v, exp: Date.now() + ttlSeconds * 1000 });
    if (this.mem.size > 5000) {
      const now = Date.now();
      for (const [k, e] of this.mem) if (e.exp <= now) this.mem.delete(k);
    }
  }

  onModuleDestroy() {
    this.redis?.disconnect();
  }
}
