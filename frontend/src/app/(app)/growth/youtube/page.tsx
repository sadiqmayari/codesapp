'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PlayCircle } from 'lucide-react';
import { count, fullMoney, money, pct } from '@/lib/format-number';
import { growthApi, type MetricDef } from '@/lib/growth';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonCards } from '@/components/ui/skeleton';
import { useGrowth } from '@/components/growth/growth-filters';
import { ErrorNote, KpiCard, Panel, useGrowthData } from '@/components/growth/ui';
import { EChart, axis, baseOption, useChartTheme } from '@/components/growth/echart';
import { BrandMark } from '@/components/icons/brand-logo';

const def = (id: string, label: string, unit: MetricDef['unit'], description: string, higherIsBetter = true): MetricDef => ({
  id, label, unit, higherIsBetter, formula: '', description,
});

const DEFS = {
  subs: def('yt_subs', 'Subscribers (net)', 'count', 'Subscribers gained minus lost in the period (YouTube Analytics).'),
  views: def('yt_views', 'Channel views', 'count', 'All views of the channel’s videos in the period (organic + ads), YouTube Analytics.'),
  watch: def('yt_watch', 'Watch hours', 'count', 'Hours watched across the channel in the period.'),
  spend: def('yt_spend', 'Video-ad spend', 'money', 'Google Ads spend on ads that play a YouTube video.', false),
  adViews: def('yt_adviews', 'Ad views', 'count', 'Google Ads video views (TrueView: watched 30 s or engaged) on video ads.'),
  cpv: def('yt_cpv', 'Cost per view', 'money', 'Video-ad spend ÷ ad views.', false),
};

export default function GrowthYoutubePage() {
  const { mode, filters } = useGrowth();
  const theme = useChartTheme();
  const [channelId, setChannelId] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const { data, loading, error } = useGrowthData((q, signal) => growthApi.youtubeOverview({ from: q.from, to: q.to, channelId }, { signal }), String(channelId ?? ''));

  useEffect(() => {
    growthApi.accounts().then((s) => setCurrency(s.baseCurrency ?? null)).catch(() => undefined);
  }, []);

  const option = useMemo(() => {
    if (!theme || !data) return null;
    const days = data.trend.map((d) => d.date.slice(5));
    return {
      ...baseOption(theme),
      grid: { left: 8, right: 8, top: 30, bottom: 4, containLabel: true },
      legend: { top: 0, right: 0, textStyle: { color: theme.muted, fontSize: 12 }, icon: 'roundRect' },
      tooltip: { ...baseOption(theme).tooltip, trigger: 'axis' },
      xAxis: { type: 'category', data: days, ...axis(theme), splitLine: { show: false } },
      yAxis: { type: 'value', ...axis(theme) },
      series: [
        { name: 'Channel views', type: 'line', smooth: true, showSymbol: false, data: data.trend.map((d) => d.organic), lineStyle: { width: 2.5, color: '#2563eb' }, itemStyle: { color: '#2563eb' }, areaStyle: { color: 'rgba(37,99,235,.08)' } },
        { name: 'Ad views', type: 'line', smooth: true, showSymbol: false, data: data.trend.map((d) => d.ads), lineStyle: { width: 2.5, color: '#f79009' }, itemStyle: { color: '#f79009' } },
      ],
    };
  }, [theme, data]);

  if (error) return <ErrorNote message={error} />;
  if (!loading && data && data.channels.length === 0 && data.ads.spend === 0) {
    return (
      <div className="rounded-xl border border-line bg-surface p-6">
        <EmptyState icon={PlayCircle} title="Connect a YouTube channel" description="See subscribers, views and watch time next to your Google video ads, and answer comments from CodesApp." />
        <div className="mt-3 text-center">
          <Link href="/growth/connections" className="inline-flex items-center gap-2 rounded-lg bg-[#CC0000] px-4 py-2 text-sm font-semibold text-white">
            Go to Connections
          </Link>
        </div>
      </div>
    );
  }
  const cmp = filters.compare === 'none' ? null : 'prev. period';
  const o = data?.organic;
  const op = data?.organicPrev;
  const a = data?.ads;
  const ap = data?.adsPrev;

  return (
    <div className="space-y-4">
      {data && data.channels.length > 1 && (
        <div className="flex items-center gap-2">
          <label htmlFor="yt-ch" className="text-sm font-semibold text-ink">Channel</label>
          <select id="yt-ch" value={channelId ?? ''} onChange={(e) => setChannelId(e.target.value ? Number(e.target.value) : null)} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink">
            <option value="">All channels</option>
            {data.channels.map((c) => <option key={c.id} value={c.id}>{c.title ?? c.handle ?? c.id}</option>)}
          </select>
        </div>
      )}
      {loading && !data ? <SkeletonCards count={6} /> : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <KpiCard def={DEFS.subs} value={o?.subsNet ?? null} prev={cmp ? op?.subsNet ?? null : null} cur={currency} mode={mode} compareLabel={cmp} />
          <KpiCard def={DEFS.views} value={o?.views ?? null} prev={cmp ? op?.views ?? null : null} cur={currency} mode={mode} compareLabel={cmp} />
          <KpiCard def={DEFS.watch} value={o ? Math.round(o.watchHours) : null} prev={cmp && op ? Math.round(op.watchHours) : null} cur={currency} mode={mode} compareLabel={cmp} />
          <KpiCard def={DEFS.spend} value={a?.spend ?? null} prev={cmp ? ap?.spend ?? null : null} cur={currency} mode={mode} compareLabel={cmp} />
          <KpiCard def={DEFS.adViews} value={a?.views ?? null} prev={cmp ? ap?.views ?? null : null} cur={currency} mode={mode} compareLabel={cmp} />
          <KpiCard def={DEFS.cpv} value={a?.cpv ?? null} prev={cmp ? ap?.cpv ?? null : null} cur={currency} mode={mode} compareLabel={cmp} />
        </div>
      )}

      <Panel title="Daily views" hint={a?.viewRate != null ? `Video ads: ${pct(a.viewRate)} view rate · ${count(a.videos, mode)} videos in ads` : 'Channel views from YouTube Analytics, ad views from Google Ads'}>
        <EChart option={option} height={260} ariaLabel="Daily channel views and ad views" />
      </Panel>

      <Panel title="Videos" hint="Lifetime views of each video, plus its Google Ads results in the period. Net sales = orders credited to the ad on last click (7 days).">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-semibold text-muted">
                <th className="py-2 pr-3">Video</th>
                <th className="px-3 py-2 text-right">Views</th>
                <th className="px-3 py-2 text-right">Comments</th>
                <th className="px-3 py-2 text-right">Ad spend</th>
                <th className="px-3 py-2 text-right">Ad views</th>
                <th className="px-3 py-2 text-right">View rate</th>
                <th className="px-3 py-2 text-right">CPV</th>
                <th className="px-3 py-2 text-right">Net sales</th>
              </tr>
            </thead>
            <tbody>
              {(data?.topVideos ?? []).map((v) => (
                <tr key={v.videoId} className="border-b border-line/60 last:border-0">
                  <td className="py-2 pr-3">
                    <a href={`https://youtu.be/${v.videoId}`} target="_blank" rel="noreferrer" className="flex items-center gap-3 text-ink hover:text-brand-700">
                      {v.thumb
                        // eslint-disable-next-line @next/next/no-img-element -- remote YouTube thumbnail
                        ? <img src={v.thumb} alt="" className="h-9 w-16 shrink-0 rounded object-cover" />
                        : <BrandMark brand="youtube" size="sm" />}
                      <span className="min-w-0">
                        <span className="line-clamp-1 font-semibold">{v.title ?? v.videoId}</span>
                        {v.usedInAds
                          ? <span className="mt-0.5 inline-block rounded-md bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">Used in {v.ads || ''} ad{v.ads === 1 ? '' : 's'}</span>
                          : <span className="block text-xs text-muted">Organic only</span>}
                      </span>
                    </a>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{count(v.views, mode)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{count(v.comments, mode)}</td>
                  <td className="px-3 py-2 text-right tabular-nums" title={fullMoney(v.adSpend, currency)}>{v.adSpend ? money(v.adSpend, currency, mode) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{v.adViews ? count(v.adViews, mode) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{v.viewRate != null ? pct(v.viewRate) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{v.cpv != null ? money(v.cpv, currency, 'full') : '—'}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{v.net ? money(v.net, currency, mode) : '—'}</td>
                </tr>
              ))}
              {!loading && !(data?.topVideos ?? []).length && (
                <tr><td colSpan={8} className="py-6 text-center text-sm text-muted">No videos yet. The first channel sync is still running.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
