import { IsDateString, IsIn, IsOptional } from 'class-validator';

/**
 * Query for the comprehensive analytics dashboard.
 *  - `from` / `to` define the active window (defaults: last 30 days → now).
 *  - `granularity` controls the time-series bucket: `hour` for ≤2-day windows,
 *    `day` for the typical 7/30/90-day windows.
 *  - `compare=true` adds previous-period values (same window length ending at
 *    `from`) into every KPI so the UI can render deltas / sparkline arrows.
 */
export class DashboardDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsIn(['hour', 'day'])
  granularity?: 'hour' | 'day';

  @IsOptional()
  @IsIn(['true', 'false'])
  compare?: 'true' | 'false';
}
