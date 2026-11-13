import type { EChartsCoreOption } from 'echarts/core';
import { axis, baseOption, type ChartTheme } from './echart';
import { axisNumber, fullMoney, ratio, type NumberMode } from '@/lib/format-number';
import { CHANNEL_COLOR, type Attribution, type Customers, type Forecast, type Overview, type SeriesPoint, type ChartSpec } from '@/lib/growth';

type Opt = EChartsCoreOption;

const dayLabel = (d: string) => {
  if (/^\d{4}-W\d{2}$/.test(d)) return d.slice(5);
  const dt = new Date(`${d}T00:00:00Z`);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

interface TP {
  axisValue?: string;
  marker?: string;
  seriesName?: string;
  value?: number | number[] | null;
  name?: string;
  data?: unknown;
  dataIndex?: number;
  percent?: number;
}

const rowsTip = (t: ChartTheme, title: string, rows: Array<[string, string, string]>) =>
  `<div style="font-weight:700;margin-bottom:4px;color:${t.ink}">${title}</div>` +
  rows
    .map(
      ([marker, name, val]) =>
        `<div style="display:flex;gap:12px;justify-content:space-between;align-items:center"><span>${marker}${name}</span><b style="font-variant-numeric:tabular-nums">${val}</b></div>`,
    )
    .join('');

/** Revenue / spend / ROAS combo with zoom, previous-period ghost and anomaly flags. */
export function trendOption(
  o: Overview,
  t: ChartTheme,
  mode: NumberMode,
  focus: 'net' | 'realized' | 'expected' | 'gross' | 'spend',
  compare: boolean,
): Opt {
  const s = o.series;
  const cur = o.currency;
  const labels = s.map((p) => dayLabel(p.date));
  const focusName = { net: 'Net sales', realized: 'Realized', expected: 'Expected net', gross: 'Gross sales', spend: 'Ad spend' }[focus];
  const focusKey: keyof SeriesPoint = focus === 'spend' ? 'net' : focus;
  const anomalyIdx = new Set(o.anomalies.map((a) => a.date));
  return {
    ...baseOption(t),
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, textStyle: { color: t.muted, fontSize: 12 } },
    grid: { left: 8, right: 8, top: 36, bottom: s.length > 20 ? 52 : 12, containLabel: true },
    tooltip: {
      ...baseOption(t).tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: t.dark ? 'rgba(255,255,255,0.04)' : 'rgba(15,23,42,0.04)' } },
      formatter: (ps: TP[]) =>
        rowsTip(
          t,
          String(ps[0]?.axisValue ?? ''),
          ps
            .filter((p) => p.value != null)
            .map((p) => [p.marker ?? '', p.seriesName ?? '', p.seriesName === 'ROAS' ? ratio(Number(p.value)) : fullMoney(Number(p.value), cur)]),
        ),
    },
    dataZoom: s.length > 20 ? [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 6, borderColor: t.line, fillerColor: 'rgba(22,163,74,0.12)', handleStyle: { color: t.brand }, textStyle: { color: t.muted }, brushSelect: false }] : [],
    xAxis: { type: 'category', data: labels, ...axis(t), splitLine: { show: false } },
    yAxis: [
      { type: 'value', ...axis(t), axisLabel: { color: t.muted, fontSize: 12, formatter: (v: number) => axisNumber(v, mode) } },
      { type: 'value', position: 'right', axisLabel: { color: t.muted, fontSize: 12, formatter: (v: number) => `${v}×` }, splitLine: { show: false }, axisLine: { show: false } },
    ],
    series: [
      { name: 'Gross sales', type: 'bar', data: s.map((p) => Math.round(p.gross)), barGap: '-100%', barMaxWidth: 22, itemStyle: { color: t.line, borderRadius: [3, 3, 0, 0] }, z: 1 },
      { name: focus === 'spend' ? 'Net sales' : focusName, type: 'bar', data: s.map((p) => Math.round(Number(p[focusKey] ?? 0))), barMaxWidth: 22, z: 2,
        itemStyle: { color: focus === 'expected' ? t.violet : focus === 'realized' ? t.good : t.brand, borderRadius: [3, 3, 0, 0] } },
      { name: 'Ad spend', type: 'line', smooth: 0.35, symbol: 'none', data: s.map((p) => Math.round(p.spend)), lineStyle: { width: focus === 'spend' ? 3 : 2.2, color: t.amber }, itemStyle: { color: t.amber },
        areaStyle: focus === 'spend' ? { color: t.amber, opacity: 0.12 } : undefined,
        markPoint: {
          symbol: 'pin', symbolSize: 34, label: { color: '#fff', fontSize: 10, formatter: '!' }, itemStyle: { color: t.bad },
          data: s.map((p, i) => (anomalyIdx.has(p.date) ? { coord: [i, Math.round(p.spend)], name: 'Anomaly' } : null)).filter(Boolean),
        } },
      { name: 'ROAS', type: 'line', yAxisIndex: 1, smooth: 0.35, symbol: 'none', connectNulls: true, data: s.map((p) => (p.roas == null ? null : Number(p.roas.toFixed(2)))), lineStyle: { width: 1.6, color: t.violet, type: [4, 3] }, itemStyle: { color: t.violet } },
      ...(compare && s.some((p) => p.prevNet != null)
        ? [{ name: 'Net · previous period', type: 'line', smooth: 0.35, symbol: 'none', data: s.map((p) => (p.prevNet == null ? null : Math.round(p.prevNet))), lineStyle: { width: 1.5, type: 'dotted', color: t.muted }, itemStyle: { color: t.muted } }]
        : []),
    ],
  };
}

/** Gross → net → profit waterfall with real axis and connector labels. */
export function waterfallOption(o: Overview, t: ChartTheme, mode: NumberMode): Opt {
  const steps = o.waterfall;
  let run = 0;
  const base: number[] = [];
  const vals: Array<{ value: number; itemStyle: Record<string, unknown> }> = [];
  for (const s of steps) {
    if (s.kind === 'total') {
      base.push(Math.min(0, s.value));
      vals.push({ value: Math.abs(s.value), itemStyle: { color: s.label === 'Net profit' ? (s.value >= 0 ? t.good : t.bad) : s.label === 'Gross sales' ? t.muted : t.brand, borderRadius: [4, 4, 0, 0] } });
      run = s.value;
    } else {
      run += s.value;
      base.push(Math.round(run));
      vals.push({ value: Math.round(-s.value), itemStyle: { color: t.bad, opacity: 0.78, borderRadius: 3 } });
    }
  }
  return {
    ...baseOption(t),
    grid: { left: 8, right: 8, top: 26, bottom: 4, containLabel: true },
    tooltip: {
      ...baseOption(t).tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (ps: TP[]) => {
        const i = ps[1]?.dataIndex ?? 0;
        const st = steps[i];
        const share = o.kpis.gross?.value ? Math.abs(st.value) / (o.kpis.gross.value as number) * 100 : null;
        return rowsTip(t, st.label, [['', st.kind === 'total' ? 'Amount' : 'Deducted', fullMoney(st.value, o.currency)], ...(share != null ? [['', 'Share of gross', `${share.toFixed(1)}%`] as [string, string, string]] : [])]);
      },
    },
    xAxis: { type: 'category', data: steps.map((s) => s.label), ...axis(t), axisLabel: { color: t.muted, fontSize: 11, interval: 0, rotate: 28 }, splitLine: { show: false } },
    yAxis: { type: 'value', ...axis(t), axisLabel: { color: t.muted, fontSize: 12, formatter: (v: number) => axisNumber(v, mode) } },
    series: [
      { type: 'bar', stack: 'w', data: base, itemStyle: { color: 'transparent' }, emphasis: { disabled: true }, silent: true, tooltip: { show: false } },
      { type: 'bar', stack: 'w', data: vals, barMaxWidth: 38,
        label: { show: true, position: 'top', fontSize: 11, fontWeight: 700, color: t.ink, formatter: (p: TP) => axisNumber(Number(p.value), mode) } },
    ],
  };
}

/** Where every placed order ended up. */
export function lifecycleSankey(o: Overview, t: ChartTheme): Opt {
  const l = o.lifecycle;
  const confirmedish = l.confirmed.gross + l.in_transit.gross + l.delivered.gross + l.rto.gross;
  const shipped = l.in_transit.gross + l.delivered.gross + l.rto.gross;
  const links = [
    { source: 'Placed', target: 'Cancelled', value: l.cancelled.gross },
    { source: 'Placed', target: 'Awaiting confirmation', value: l.unconfirmed.gross },
    { source: 'Placed', target: 'Confirmed', value: confirmedish },
    { source: 'Confirmed', target: 'Awaiting booking', value: l.confirmed.gross },
    { source: 'Confirmed', target: 'Shipped', value: shipped },
    { source: 'Shipped', target: 'Delivered', value: l.delivered.gross },
    { source: 'Shipped', target: 'In transit', value: l.in_transit.gross },
    { source: 'Shipped', target: 'Returned (RTO)', value: l.rto.gross },
  ].filter((x) => x.value > 0);
  const used = new Set(links.flatMap((x) => [x.source, x.target]));
  const color: Record<string, string> = {
    Placed: t.muted, Cancelled: t.bad, 'Awaiting confirmation': t.amber, Confirmed: t.cyan, 'Awaiting booking': t.amber,
    Shipped: t.blue, Delivered: t.good, 'In transit': t.violet, 'Returned (RTO)': t.bad,
  };
  const orders: Record<string, number> = {
    Placed: l.placed.orders, Cancelled: l.cancelled.orders, 'Awaiting confirmation': l.unconfirmed.orders,
    Confirmed: l.confirmed.orders + l.in_transit.orders + l.delivered.orders + l.rto.orders, 'Awaiting booking': l.confirmed.orders,
    Shipped: l.in_transit.orders + l.delivered.orders + l.rto.orders, Delivered: l.delivered.orders, 'In transit': l.in_transit.orders,
    'Returned (RTO)': l.rto.orders,
  };
  return {
    ...baseOption(t),
    tooltip: {
      ...baseOption(t).tooltip,
      formatter: (p: TP & { dataType?: string }) => {
        const d = p.data as { source?: string; target?: string; value?: number; name?: string };
        if (p.dataType === 'edge') return rowsTip(t, `${d.source} → ${d.target}`, [['', 'Gross value', fullMoney(d.value ?? 0, o.currency)], ['', 'Share of placed', `${(((d.value ?? 0) / (l.placed.gross || 1)) * 100).toFixed(1)}%`]]);
        return rowsTip(t, String(p.name), [['', 'Orders', (orders[String(p.name)] ?? 0).toLocaleString()]]);
      },
    },
    series: [{
      type: 'sankey', left: 4, right: 128, top: 8, bottom: 8, nodeGap: 12, nodeWidth: 12, draggable: false,
      emphasis: { focus: 'adjacency' },
      lineStyle: { color: 'gradient', opacity: 0.32, curveness: 0.5 },
      label: { color: t.ink, fontSize: 12, fontWeight: 600, formatter: (p: TP) => `${p.name}  {o|${(orders[String(p.name)] ?? 0).toLocaleString()}}`, rich: { o: { color: t.muted, fontWeight: 500, fontSize: 11 } } },
      data: Array.from(used).map((n) => ({ name: n, itemStyle: { color: color[n] ?? t.muted, borderWidth: 0 } })),
      links,
    }],
  };
}

export function channelDonut(o: Overview, t: ChartTheme, mode: NumberMode, totalLabel: string): Opt {
  const rows = o.channels.filter((c) => c.net > 0);
  const total = rows.reduce((a, c) => a + c.net, 0);
  return {
    ...baseOption(t),
    tooltip: { ...baseOption(t).tooltip, formatter: (p: TP) => rowsTip(t, String(p.name), [['', 'Net sales', fullMoney(Number(p.value), o.currency)], ['', 'Share', `${p.percent?.toFixed(1)}%`]]) },
    legend: { bottom: 0, type: 'scroll', icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: t.muted, fontSize: 12 } },
    series: [{
      type: 'pie', radius: ['52%', '76%'], center: ['50%', '44%'], avoidLabelOverlap: true, padAngle: 1.5,
      itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 4 },
      label: { show: true, position: 'center', formatter: () => `{a|${axisNumber(total, mode)}}\n{b|${totalLabel}}`, rich: { a: { fontSize: 20, fontWeight: 800, color: t.ink, lineHeight: 26 }, b: { fontSize: 12, color: t.muted } } },
      labelLine: { show: false },
      emphasis: { scaleSize: 6, label: { show: true } },
      data: rows.map((c) => ({ name: c.label, value: Math.round(c.net), itemStyle: { color: CHANNEL_COLOR[c.channel] ?? t.muted } })),
    }],
  };
}

export function scatterOption(rows: Array<{ name: string; spend: number; expRoas: number | null; orders: number }>, breakEven: number | null, t: ChartTheme, mode: NumberMode, cur: string | null): Opt {
  const data = rows.filter((r) => r.spend > 0 && r.expRoas != null).map((r) => [r.spend, Number((r.expRoas as number).toFixed(2)), Math.max(1, r.orders), r.name]);
  return {
    ...baseOption(t),
    grid: { left: 8, right: 24, top: 24, bottom: 8, containLabel: true },
    tooltip: { ...baseOption(t).tooltip, formatter: (p: TP) => { const d = p.data as [number, number, number, string]; return rowsTip(t, d[3], [['', 'Spend', fullMoney(d[0], cur)], ['', 'Expected ROAS', ratio(d[1])], ['', 'Orders', Math.round(d[2]).toLocaleString()]]); } },
    xAxis: { type: 'value', name: 'Spend', nameTextStyle: { color: t.muted }, ...axis(t), axisLabel: { color: t.muted, formatter: (v: number) => axisNumber(v, mode) } },
    yAxis: { type: 'value', name: 'Expected ROAS', nameTextStyle: { color: t.muted }, ...axis(t), axisLabel: { color: t.muted, formatter: (v: number) => `${v}×` } },
    series: [{
      type: 'scatter', data,
      symbolSize: (d: number[]) => Math.min(48, 10 + Math.sqrt(d[2]) * 3),
      itemStyle: { color: (p: TP) => { const v = (p.data as number[])[1]; return breakEven == null ? t.brand : v >= breakEven * 1.3 ? t.good : v >= breakEven ? t.amber : t.bad; }, opacity: 0.85, borderColor: t.surface, borderWidth: 1 },
      label: { show: data.length <= 12, position: 'right', color: t.ink, fontSize: 11, formatter: (p: TP) => String((p.data as unknown[])[3]).slice(0, 22) },
      markLine: breakEven == null ? undefined : { silent: true, symbol: 'none', lineStyle: { color: t.muted, type: 'dashed' }, label: { color: t.muted, formatter: `Break-even ${breakEven.toFixed(2)}×` }, data: [{ yAxis: Number(breakEven.toFixed(2)) }] },
    }],
  };
}

export function journeySankey(a: Attribution, t: ChartTheme): Opt {
  const label = (c: string) => a.labels[c] ?? c;
  const links = a.journey
    .filter((j) => j.orders > 0 && j.from !== 'unknown')
    .map((j) => ({ source: `${label(j.from)} `, target: `${label(j.to)}  `, value: j.orders }))
    .sort((x, y) => y.value - x.value)
    .slice(0, 24);
  const nodes = Array.from(new Set(links.flatMap((l) => [l.source, l.target])));
  const key = (n: string) => Object.entries(a.labels).find(([, v]) => v === n.trim())?.[0] ?? '';
  return {
    ...baseOption(t),
    tooltip: { ...baseOption(t).tooltip, formatter: (p: TP & { dataType?: string }) => { const d = p.data as { source?: string; target?: string; value?: number }; return p.dataType === 'edge' ? rowsTip(t, `First: ${d.source?.trim()} → Last: ${d.target?.trim()}`, [['', 'Orders', String(d.value)]]) : String(p.name).trim(); } },
    series: [{
      type: 'sankey', left: 4, right: 140, top: 8, bottom: 8, nodeGap: 10, nodeWidth: 12, emphasis: { focus: 'adjacency' },
      lineStyle: { color: 'gradient', opacity: 0.32, curveness: 0.5 },
      label: { color: t.ink, fontSize: 12, fontWeight: 600 },
      data: nodes.map((n) => ({ name: n, itemStyle: { color: CHANNEL_COLOR[key(n)] ?? t.muted, borderWidth: 0 } })),
      links,
    }],
  };
}

export function funnelOption(steps: Array<[string, number, string]>, t: ChartTheme): Opt {
  const top = steps[0]?.[1] || 1;
  return {
    ...baseOption(t),
    tooltip: { ...baseOption(t).tooltip, formatter: (p: TP) => rowsTip(t, String(p.name), [['', 'Count', Number(p.value).toLocaleString()], ['', 'Of first step', `${((Number(p.value) / top) * 100).toFixed(1)}%`]]) },
    series: [{
      type: 'funnel', left: '6%', width: '88%', top: 8, bottom: 8, sort: 'none', gap: 3, minSize: '14%',
      label: { show: true, position: 'inside', color: '#fff', fontWeight: 700, fontSize: 12, formatter: (p: TP) => `${p.name}  ${Number(p.value).toLocaleString()}` },
      itemStyle: { borderColor: t.surface, borderWidth: 1 },
      data: steps.map(([name, value, color]) => ({ name, value, itemStyle: { color } })),
    }],
  };
}

export function barOption(labels: string[], values: number[], t: ChartTheme, fmt: (v: number) => string, color?: string): Opt {
  return {
    ...baseOption(t),
    grid: { left: 8, right: 8, top: 22, bottom: 4, containLabel: true },
    tooltip: { ...baseOption(t).tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps: TP[]) => rowsTip(t, String(ps[0]?.axisValue), [['', '', fmt(Number(ps[0]?.value))]]) },
    xAxis: { type: 'category', data: labels, ...axis(t), splitLine: { show: false } },
    yAxis: { type: 'value', ...axis(t), axisLabel: { color: t.muted, fontSize: 12, formatter: (v: number) => fmt(v) } },
    series: [{ type: 'bar', data: values, barMaxWidth: 42, itemStyle: { color: color ?? t.brand, borderRadius: [4, 4, 0, 0] }, label: { show: true, position: 'top', color: t.ink, fontWeight: 700, fontSize: 11, formatter: (p: TP) => fmt(Number(p.value)) } }],
  };
}

export function cohortHeatmap(c: Customers, t: ChartTheme, mode: NumberMode, cur: string | null): Opt {
  const cohorts = c.cohorts.map((x) => x.cohort);
  const maxLen = Math.max(1, ...c.cohorts.map((x) => x.values.length));
  const months = Array.from({ length: maxLen }, (_, i) => `M${i}`);
  const data: Array<[number, number, number]> = [];
  c.cohorts.forEach((row, y) => row.values.forEach((v, x) => data.push([x, y, Math.round(v)])));
  const vals = data.map((d) => d[2]);
  const ramp = t.dark ? ['#0f2a1c', '#14532d', '#15803d', '#22c55e', '#86efac'] : ['#f0fdf4', '#bbf7d0', '#4ade80', '#16a34a', '#14532d'];
  return {
    ...baseOption(t),
    grid: { left: 8, right: 8, top: 8, bottom: 52, containLabel: true },
    tooltip: { ...baseOption(t).tooltip, formatter: (p: TP) => { const d = p.data as [number, number, number]; const row = c.cohorts[d[1]]; return rowsTip(t, `${row.cohort} cohort · ${months[d[0]]}`, [['', 'Revenue per customer', fullMoney(d[2], cur)], ['', 'Customers', row.size.toLocaleString()]]); } },
    xAxis: { type: 'category', data: months, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.muted } },
    yAxis: { type: 'category', data: cohorts, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.muted, formatter: (v: string) => `${v}  (${c.cohorts.find((x) => x.cohort === v)?.size ?? 0})` } },
    visualMap: { min: vals.length ? Math.min(...vals) : 0, max: vals.length ? Math.max(...vals) : 1, calculable: true, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 160, textStyle: { color: t.muted }, inRange: { color: ramp }, formatter: (v: number) => axisNumber(v, mode) },
    series: [{ type: 'heatmap', data, label: { show: true, fontSize: 11, fontWeight: 700, color: t.ink, formatter: (p: TP) => axisNumber((p.data as number[])[2], mode) }, itemStyle: { borderColor: t.surface, borderWidth: 3, borderRadius: 4 } }],
  };
}

export function newVsReturning(c: Customers, t: ChartTheme, mode: NumberMode, cur: string | null): Opt {
  return {
    ...baseOption(t),
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, textStyle: { color: t.muted } },
    grid: { left: 8, right: 8, top: 32, bottom: 4, containLabel: true },
    tooltip: { ...baseOption(t).tooltip, trigger: 'axis', formatter: (ps: TP[]) => rowsTip(t, String(ps[0]?.axisValue), ps.map((p) => [p.marker ?? '', p.seriesName ?? '', fullMoney(Number(p.value), cur)])) },
    xAxis: { type: 'category', data: c.series.map((d) => dayLabel(d.date)), ...axis(t), splitLine: { show: false } },
    yAxis: { type: 'value', ...axis(t), axisLabel: { color: t.muted, formatter: (v: number) => axisNumber(v, mode) } },
    series: [
      { name: 'New customers', type: 'bar', stack: 'a', data: c.series.map((d) => Math.round(d.newNet)), itemStyle: { color: t.brand }, barMaxWidth: 18 },
      { name: 'Returning', type: 'bar', stack: 'a', data: c.series.map((d) => Math.round(d.returningNet)), itemStyle: { color: t.cyan, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 18 },
    ],
  };
}

/** Month pacing: cumulative actual + projection band + last month's pace. */
export function pacingOption(f: Forecast, metric: 'net' | 'expected' | 'gross' | 'spend', t: ChartTheme, mode: NumberMode): Opt {
  const m = f[metric];
  const days: string[] = [];
  for (let d = f.monthStart; d <= f.monthEnd; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) days.push(d);
  const actualByDay = new Map(f.actual.map((a) => [a.date, a[metric]]));
  const fcByDay = new Map(m.daily.map((p) => [p.date, p]));
  let cum = 0;
  let lo = 0;
  let mid = 0;
  let hi = 0;
  const act: Array<number | null> = [];
  const loS: Array<number | null> = [];
  const band: Array<number | null> = [];
  const midS: Array<number | null> = [];
  for (const d of days) {
    if (d < f.today) {
      cum += actualByDay.get(d) ?? 0;
      act.push(Math.round(cum));
      loS.push(null);
      band.push(null);
      midS.push(null);
      lo = mid = hi = cum;
    } else {
      const p = fcByDay.get(d);
      if (d === f.today) act.push(Math.round(cum + (actualByDay.get(d) ?? 0)));
      else act.push(null);
      lo += p?.lo ?? 0;
      mid += p?.mid ?? 0;
      hi += p?.hi ?? 0;
      loS.push(Math.round(lo));
      band.push(Math.round(hi - lo));
      midS.push(Math.round(mid));
    }
  }
  const lastPace = f[metric].lastMonthTotal / days.length;
  return {
    ...baseOption(t),
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, textStyle: { color: t.muted }, data: ['Actual', 'Projection', 'Last month pace'] },
    grid: { left: 8, right: 12, top: 34, bottom: 4, containLabel: true },
    tooltip: {
      ...baseOption(t).tooltip, trigger: 'axis',
      formatter: (ps: TP[]) => {
        const i = ps[0]?.dataIndex ?? 0;
        const rows: Array<[string, string, string]> = [];
        if (act[i] != null) rows.push(['', 'Actual (cumulative)', fullMoney(act[i] as number, f.currency)]);
        if (midS[i] != null) rows.push(['', 'Projection', fullMoney(midS[i] as number, f.currency)], ['', '80% range', `${fullMoney(loS[i] as number, f.currency)} – ${fullMoney((loS[i] as number) + (band[i] as number), f.currency)}`]);
        rows.push(['', 'Last month pace', fullMoney(lastPace * (i + 1), f.currency)]);
        return rowsTip(t, dayLabel(days[i]), rows);
      },
    },
    xAxis: { type: 'category', data: days.map(dayLabel), boundaryGap: false, ...axis(t), splitLine: { show: false } },
    yAxis: { type: 'value', ...axis(t), axisLabel: { color: t.muted, formatter: (v: number) => axisNumber(v, mode) } },
    series: [
      { name: 'lo', type: 'line', data: loS, stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, tooltip: { show: false } },
      { name: 'band', type: 'line', data: band, stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: t.brand, opacity: 0.14 }, tooltip: { show: false } },
      { name: 'Actual', type: 'line', data: act, symbol: 'none', lineStyle: { width: 2.8, color: t.brand }, itemStyle: { color: t.brand }, areaStyle: { color: t.brand, opacity: 0.06 } },
      { name: 'Projection', type: 'line', data: midS, symbol: 'none', lineStyle: { width: 2, type: 'dashed', color: t.brand }, itemStyle: { color: t.brand } },
      { name: 'Last month pace', type: 'line', data: days.map((_, i) => Math.round(lastPace * (i + 1))), symbol: 'none', lineStyle: { width: 1.4, type: [6, 4], color: t.amber }, itemStyle: { color: t.amber } },
    ],
  };
}

export function askChartOption(c: ChartSpec, t: ChartTheme, mode: NumberMode): Opt {
  const palette = [t.brand, t.violet, t.amber];
  return {
    ...baseOption(t),
    legend: c.series.length > 1 ? { top: 0, textStyle: { color: t.muted, fontSize: 11 } } : undefined,
    grid: { left: 4, right: 8, top: c.series.length > 1 ? 28 : 10, bottom: 4, containLabel: true },
    tooltip: { ...baseOption(t).tooltip, trigger: 'axis' },
    xAxis: { type: 'category', data: c.x, ...axis(t), axisLabel: { color: t.muted, fontSize: 11 }, splitLine: { show: false } },
    yAxis: { type: 'value', ...axis(t), axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => axisNumber(v, mode) } },
    series: c.series.map((s, i) => ({ name: s.name, type: c.type, data: s.data, smooth: 0.3, symbol: 'none', barMaxWidth: 18, itemStyle: { color: palette[i] }, lineStyle: { width: 2, color: palette[i] } })),
  };
}
