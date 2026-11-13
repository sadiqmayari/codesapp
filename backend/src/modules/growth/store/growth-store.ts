/**
 * Analytical store abstraction. Growth queries are written ONCE in a portable
 * SQL subset (SUM/COUNT/IF/COALESCE/GROUP BY) with `:name` params and `{table}`
 * tokens; each store renders them for its engine:
 *   - MariaDbStore: `?` positional params, plain tables (source of truth).
 *   - ClickHouseStore: `{name:Type}` params, ReplacingMergeTree tables with FINAL.
 * The service picks ClickHouse when it is configured + healthy + mirrored for
 * the tenant, else MariaDB — the dashboards never break if ClickHouse is down.
 */
export type ParamType = 'Int32' | 'Int64' | 'Float64' | 'String' | 'Date';
export type Params = Record<string, [ParamType, string | number]>;
export type Row = Record<string, unknown>;

export type TableToken = 'facts' | 'attr' | 'ins';

export interface GrowthStore {
  readonly name: 'mariadb' | 'clickhouse';
  query<T extends Row = Row>(sql: string, params: Params): Promise<T[]>;
}

/** Pull `:name` tokens out in order of appearance. */
export function paramOrder(sql: string): string[] {
  return [...sql.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]);
}

/** Normalize a date-ish cell to YYYY-MM-DD (MariaDB returns DATE as a JS Date). */
export function ymdCell(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? '').slice(0, 10);
}
