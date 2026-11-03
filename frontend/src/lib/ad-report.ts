import { apiFetch } from '@/lib/api';

export interface MetaAdsSchedule {
  intervalMinutes: number | null;
  effectiveMinutes: number;
  defaultMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  lastRunAt: string | null;
  nextDueAt: string | null;
}

export function getMetaAdsSchedule() {
  return apiFetch<MetaAdsSchedule>('/meta-ads/sync-schedule');
}
export function setMetaAdsSchedule(intervalMinutes: number | null) {
  return apiFetch<{ intervalMinutes: number | null }>('/meta-ads/sync-schedule', {
    method: 'PUT',
    body: { intervalMinutes },
  });
}
export function triggerMetaAdsSync() {
  return apiFetch<{ started: true }>('/meta-ads/sync', { method: 'POST' });
}
export function backfillAttribution() {
  return apiFetch<{ enqueued: number }>('/meta-ads/attribution/backfill', {
    method: 'POST',
  });
}

export const SYNC_INTERVAL_OPTIONS: Array<[number | null, string]> = [
  [null, 'Auto: 4 hours (default)'],
  [30, 'Auto: 30 min'],
  [60, 'Auto: 1 hour'],
  [120, 'Auto: 2 hours'],
  [240, 'Auto: 4 hours'],
  [360, 'Auto: 6 hours'],
  [720, 'Auto: 12 hours'],
  [1440, 'Auto: Once a day'],
];
