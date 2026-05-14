import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type NodeCacheType from 'node-cache';

// node-cache ships as a CommonJS module without a default export
// eslint-disable-next-line @typescript-eslint/no-require-imports
const NodeCacheCtor = require('node-cache') as typeof NodeCacheType;

@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly cache: NodeCacheType;

  constructor() {
    this.cache = new NodeCacheCtor({ useClones: false });
  }

  get<T>(key: string): T | undefined {
    return this.cache.get<T>(key);
  }

  set<T>(key: string, value: T, ttlSeconds: number): void {
    this.cache.set(key, value, ttlSeconds);
  }

  del(key: string): void {
    this.cache.del(key);
  }

  subscriptionKey(companyId: number): string {
    return `subscription:${companyId}`;
  }

  analyticsKey(companyId: number, hash: string): string {
    return `analytics:${companyId}:${hash}`;
  }

  onModuleDestroy() {
    this.cache.close();
  }
}
