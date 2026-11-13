import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { GrowthStore, paramOrder, Params, Row } from './growth-store';

const TABLES: Record<string, string> = {
  facts: 'growth_order_facts',
  attr: 'growth_attribution',
  ins: 'ad_insights_daily',
};

@Injectable()
export class MariaDbStore implements GrowthStore {
  readonly name = 'mariadb' as const;

  constructor(private readonly prisma: PrismaService) {}

  async query<T extends Row = Row>(sql: string, params: Params): Promise<T[]> {
    const order = paramOrder(sql);
    const rendered = sql
      .replace(/\{(facts|attr|ins)\}/g, (_, t: string) => TABLES[t])
      .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '?');
    const values = order.map((k) => {
      const p = params[k];
      if (!p) throw new Error(`Missing growth query param :${k}`);
      return p[1];
    });
    return this.prisma.$queryRawUnsafe<T[]>(rendered, ...values);
  }
}
