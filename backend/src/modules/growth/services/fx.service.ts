import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { httpJson } from '../platforms/http';

/**
 * Daily FX for converting ad spend (ad-account currency) into the tenant's base
 * (store) currency. Source: open.er-api.com (free, no key, includes PKR). It only
 * serves the CURRENT rate, so we snapshot one rate per day; a past day uses the
 * nearest earlier snapshot (else the oldest one we have).
 */
@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  private readonly mem = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async rate(base: string | null, quote: string | null, day: string): Promise<number> {
    if (!base || !quote || base === quote) return 1;
    const key = `${base}>${quote}>${day}`;
    const hit = this.mem.get(key);
    if (hit) return hit;
    let row = await this.prisma.fxRateDaily.findFirst({
      where: { base, quote, date: { lte: new Date(`${day}T00:00:00Z`) } },
      orderBy: { date: 'desc' },
    });
    if (!row) {
      await this.snapshot(base).catch(() => undefined);
      row = await this.prisma.fxRateDaily.findFirst({ where: { base, quote }, orderBy: { date: 'asc' } });
    }
    const r = row ? Number(row.rate) : 1;
    if (!row) this.logger.warn(`No FX rate ${base}→${quote}; using 1.0`);
    this.mem.set(key, r);
    return r;
  }

  /** Store today's rates for one base currency (idempotent per day). */
  async snapshot(base: string): Promise<void> {
    const res = await httpJson<{ result?: string; rates?: Record<string, number> }>(
      'GET',
      `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`,
      {},
    );
    if (res.body.result !== 'success' || !res.body.rates) return;
    const date = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    const rows = Object.entries(res.body.rates)
      .filter(([q, r]) => /^[A-Z]{3}$/.test(q) && r > 0)
      .map(([quote, rate]) => ({ base, quote, date, rate }));
    await this.prisma.fxRateDaily.createMany({ data: rows, skipDuplicates: true });
    this.mem.clear();
  }

  /** Daily job: snapshot every currency used by a connected ad account. */
  async snapshotAll(): Promise<void> {
    const bases = await this.prisma.adAccount.findMany({
      where: { status: 'active', currency: { not: null } },
      select: { currency: true },
      distinct: ['currency'],
    });
    for (const b of bases) {
      if (b.currency) await this.snapshot(b.currency).catch((e) => this.logger.warn(`fx ${b.currency}: ${e}`));
    }
  }
}
