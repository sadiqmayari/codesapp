import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, ClickHouseClient } from '@clickhouse/client';
import { GrowthStore, paramOrder, Params, Row } from './growth-store';

const TABLES: Record<string, string> = {
  facts: 'growth_order_facts FINAL',
  attr: 'growth_attribution',
  ins: 'ad_insights_daily',
};

/**
 * Self-hosted ClickHouse (derived, rebuildable copy of the Growth facts). Fully
 * optional: unset CLICKHOUSE_URL ⇒ `enabled=false` and MariaDB serves every
 * query. Health is re-checked every minute; a failed ping flips reads back to
 * MariaDB automatically.
 */
@Injectable()
export class ClickHouseStore implements GrowthStore, OnModuleInit, OnModuleDestroy {
  readonly name = 'clickhouse' as const;
  private readonly logger = new Logger(ClickHouseStore.name);
  private client?: ClickHouseClient;
  private healthy = false;
  private schemaReady = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly config: ConfigService) {}

  get enabled() {
    return !!this.client;
  }

  get isHealthy() {
    return this.healthy && this.schemaReady;
  }

  onModuleInit() {
    const url = this.config.get<string>('CLICKHOUSE_URL');
    if (!url) {
      this.logger.log('CLICKHOUSE_URL not set — Growth reads use MariaDB');
      return;
    }
    this.client = createClient({
      url,
      username: this.config.get<string>('CLICKHOUSE_USER') ?? 'default',
      password: this.config.get<string>('CLICKHOUSE_PASSWORD') ?? '',
      database: this.config.get<string>('CLICKHOUSE_DB') ?? 'default',
      request_timeout: 30_000,
      max_open_connections: 4,
      clickhouse_settings: {
        date_time_input_format: 'best_effort',
        max_threads: 2,
        max_memory_usage: '700000000',
      },
    });
    void this.check();
    this.timer = setInterval(() => void this.check(), 60_000);
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.client?.close().catch(() => undefined);
  }

  private async check() {
    if (!this.client) return;
    try {
      const r = await this.client.ping();
      this.healthy = r.success;
      if (this.healthy && !this.schemaReady) await this.ensureSchema();
    } catch (e) {
      if (this.healthy) this.logger.warn(`ClickHouse unhealthy: ${(e as Error).message}`);
      this.healthy = false;
    }
  }

  private async ensureSchema() {
    if (!this.client) return;
    const ddl = [
      `CREATE TABLE IF NOT EXISTS growth_order_facts (
        company_id Int32, order_gid String, store_id Nullable(Int32), order_date Date, order_month String,
        cohort_month Nullable(String), created_at DateTime64(3), lifecycle LowCardinality(String),
        payment LowCardinality(String), gross Decimal(14,2), net Decimal(14,2), discounts Decimal(14,2),
        cogs Decimal(14,2), units Int32, units_no_cost Int32, ship_cost Decimal(14,2), ship_estimated UInt8,
        fees Decimal(14,2), has_breakdown UInt8, p_deliver Decimal(6,4), city Nullable(String),
        courier Nullable(String), customer_key Nullable(String), is_new UInt8, ft_channel Nullable(String),
        ft_platform Nullable(String), ft_campaign_id Nullable(String), lt_channel Nullable(String),
        lt_platform Nullable(String), lt_campaign_id Nullable(String), touches Int32,
        days_to_convert Nullable(Int32), version Int64, updated_at DateTime64(3)
      ) ENGINE = ReplacingMergeTree(version) PARTITION BY toYYYYMM(order_date) ORDER BY (company_id, order_gid)`,
      `CREATE TABLE IF NOT EXISTS growth_attribution (
        company_id Int32, order_gid String, order_date Date, model LowCardinality(String), win Int32,
        channel LowCardinality(String), platform Nullable(String), campaign_id Nullable(String),
        adset_id Nullable(String), ad_id Nullable(String), credit Decimal(6,4), net Decimal(14,2),
        expected_net Decimal(14,2), delivered Decimal(14,2), is_new UInt8, version Int64
      ) ENGINE = MergeTree PARTITION BY toYYYYMM(order_date) ORDER BY (company_id, model, win, order_date, order_gid)`,
      `CREATE TABLE IF NOT EXISTS ad_insights_daily (
        company_id Int32, account_id Int32, platform LowCardinality(String), date Date, campaign_id String,
        adset_id Nullable(String), ad_id String, spend Decimal(14,2), spend_base Decimal(14,2), impressions Int64,
        reach Int64, clicks Int64, link_clicks Int64, video_3s Int64, thruplay Int64, add_to_cart Int64,
        checkouts Int64, purchases Int64, purchase_value_base Decimal(14,2), messaging_started Int64
      ) ENGINE = MergeTree PARTITION BY toYYYYMM(date) ORDER BY (company_id, date, account_id, ad_id)`,
    ];
    for (const q of ddl) await this.client.command({ query: q });
    this.schemaReady = true;
    this.logger.log('ClickHouse schema ready');
  }

  async query<T extends Row = Row>(sql: string, params: Params): Promise<T[]> {
    if (!this.client) throw new Error('ClickHouse not configured');
    const query_params: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const k of paramOrder(sql)) {
      if (seen.has(k)) continue;
      seen.add(k);
      if (!params[k]) throw new Error(`Missing growth query param :${k}`);
      query_params[k] = params[k][1];
    }
    const rendered = sql
      .replace(/\{(facts|attr|ins)\}/g, (_, t: string) => TABLES[t])
      .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, k: string) => `{${k}:${params[k][0]}}`);
    const rs = await this.client.query({ query: rendered, query_params, format: 'JSONEachRow' });
    return (await rs.json()) as T[];
  }

  // ── mirror helpers (used by GrowthMirrorService) ─────────────────────────────
  async insert(table: string, values: Record<string, unknown>[]) {
    if (!this.client || !values.length) return;
    await this.client.insert({ table, values, format: 'JSONEachRow' });
  }

  async command(query: string, query_params?: Record<string, unknown>) {
    if (!this.client) return;
    await this.client.command({ query, query_params });
  }

  async scalar(query: string, query_params?: Record<string, unknown>): Promise<unknown> {
    if (!this.client) return null;
    const rs = await this.client.query({ query, query_params, format: 'JSONEachRow' });
    const rows = (await rs.json()) as Array<Record<string, unknown>>;
    const first = rows[0];
    return first ? Object.values(first)[0] : null;
  }
}
