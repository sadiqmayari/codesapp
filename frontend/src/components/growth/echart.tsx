'use client';

import { useEffect, useRef, useState } from 'react';
import type { ECharts, EChartsCoreOption } from 'echarts/core';
import { cn } from '@/lib/utils';

type EChartsCore = typeof import('echarts/core');
let loader: Promise<EChartsCore> | null = null;

/** Lazy, tree-shaken ECharts (only the chart types Growth uses). */
function loadECharts(): Promise<EChartsCore> {
  if (!loader) {
    loader = (async () => {
      const [core, charts, comps, renderers] = await Promise.all([
        import('echarts/core'),
        import('echarts/charts'),
        import('echarts/components'),
        import('echarts/renderers'),
      ]);
      core.use([
        charts.BarChart, charts.LineChart, charts.PieChart, charts.SankeyChart, charts.FunnelChart,
        charts.HeatmapChart, charts.ScatterChart, charts.TreemapChart,
        comps.GridComponent, comps.TooltipComponent, comps.LegendComponent, comps.DataZoomComponent,
        comps.MarkLineComponent, comps.MarkPointComponent, comps.MarkAreaComponent, comps.VisualMapComponent,
        comps.ToolboxComponent, comps.AriaComponent,
        renderers.CanvasRenderer,
      ]);
      return core;
    })();
  }
  return loader;
}

/** Design tokens as concrete colours (tokens are stored as "R G B" channels). */
export interface ChartTheme {
  ink: string;
  muted: string;
  line: string;
  surface: string;
  sunken: string;
  brand: string;
  brandSoft: string;
  good: string;
  bad: string;
  warn: string;
  violet: string;
  blue: string;
  amber: string;
  cyan: string;
  dark: boolean;
}

export function readTheme(): ChartTheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, fb: string) => {
    const raw = cs.getPropertyValue(n).trim();
    return raw ? `rgb(${raw.split(/\s+/).join(',')})` : fb;
  };
  const dark = document.documentElement.classList.contains('dark');
  return {
    ink: v('--ink', '#111827'),
    muted: v('--muted', '#6b7280'),
    line: v('--line', '#e5e7eb'),
    surface: v('--surface', '#ffffff'),
    sunken: v('--sunken', '#f9fafb'),
    brand: v('--brand-600', '#16a34a'),
    brandSoft: v('--brand-200', '#bbf7d0'),
    good: dark ? '#4ade80' : '#15803d',
    bad: dark ? '#f87171' : '#dc2626',
    warn: dark ? '#fbbf24' : '#b45309',
    violet: dark ? '#a78bfa' : '#7c3aed',
    blue: dark ? '#818cf8' : '#4f46e5',
    amber: dark ? '#fbbf24' : '#d97706',
    cyan: dark ? '#22d3ee' : '#0891b2',
    dark,
  };
}

/** Shared chart chrome so every Growth chart looks like one system. */
export function baseOption(t: ChartTheme) {
  return {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'var(--font-sans), Manrope, system-ui, sans-serif', color: t.muted },
    animationDuration: 450,
    aria: { enabled: true },
    tooltip: {
      backgroundColor: t.surface,
      borderColor: t.line,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: t.ink, fontSize: 12 },
      extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.14);',
    },
  };
}

export function axis(t: ChartTheme) {
  return {
    axisLine: { lineStyle: { color: t.line } },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 12 },
    splitLine: { lineStyle: { color: t.line, type: 'dashed' as const } },
  };
}

/** Watches the theme class on <html> so charts re-colour on light/dark switches. */
export function useChartTheme(): ChartTheme | null {
  const [t, setT] = useState<ChartTheme | null>(null);
  useEffect(() => {
    setT(readTheme());
    const obs = new MutationObserver(() => setT(readTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return t;
}

export function EChart({
  option,
  height = 300,
  className,
  onClick,
  ariaLabel,
}: {
  option: EChartsCoreOption | null;
  height?: number;
  className?: string;
  onClick?: (p: { name?: string; seriesName?: string; dataIndex?: number; data?: unknown }) => void;
  ariaLabel?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const inst = useRef<ECharts | null>(null);
  const clickRef = useRef(onClick);
  clickRef.current = onClick;

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    void loadECharts().then((ec) => {
      if (disposed || !el.current) return;
      inst.current = ec.init(el.current, undefined, { renderer: 'canvas' });
      inst.current.on('click', (p) => clickRef.current?.(p as never));
      if (option) inst.current.setOption(option, true);
      ro = new ResizeObserver(() => inst.current?.resize());
      ro.observe(el.current);
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      inst.current?.dispose();
      inst.current = null;
    };
    // init once; option updates are handled below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (inst.current && option) inst.current.setOption(option, true);
  }, [option]);

  return (
    <div
      ref={el}
      role="img"
      aria-label={ariaLabel}
      className={cn('w-full', className)}
      style={{ height }}
    />
  );
}
