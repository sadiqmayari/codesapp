import {
  IsDateString,
  IsIn,
  IsNumberString,
  IsOptional,
  Matches,
} from 'class-validator';

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

  /**
   * Multi-Store: restrict the Orders analytics board to one connected store
   * (the "All stores" filter). Omitted = combined across every store. Passed as
   * a query-string number.
   */
  @IsOptional()
  @IsNumberString()
  storeId?: string;

  /**
   * Product-ROAS report only: the calendar month to view ("YYYY-MM"). Omitted =
   * the current (tenant-local) month. For the current month "Till Date" is MTD
   * and "Today" is the live day; for a past month the whole month is shown and
   * "Today" is that month's last day.
   */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/)
  month?: string;
}
