/** Pure forecasting maths (no Nest/DB imports — unit-testable). */
const Z80 = 1.2816; // two-sided 80% band → p10 / p90

export interface Point {
  date: string;
  value: number;
}

/**
 * Seasonal (day-of-week) level + damped-trend forecast — no ML dependency.
 * index[dow] from the last 8 complete weeks, level/slope from the last 28
 * deseasonalized days, band from in-sample residuals. Good enough to pace a
 * month; the UI labels it a projection, never a promise.
 */
export function forecastSeries(history: Point[], horizon: string[]) {
  const hist = history.filter((p) => Number.isFinite(p.value));
  if (hist.length < 14) {
    const avg = hist.length ? hist.reduce((a, p) => a + p.value, 0) / hist.length : 0;
    return horizon.map((date) => ({ date, mid: avg, lo: avg * 0.7, hi: avg * 1.3 }));
  }
  const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
  const recent56 = hist.slice(-56);
  const mean = recent56.reduce((a, p) => a + p.value, 0) / recent56.length || 1;
  const idx = new Array(7).fill(1).map((_, k) => {
    const v = recent56.filter((p) => dow(p.date) === k).map((p) => p.value);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length / mean || 1 : 1;
  });
  const recent = hist.slice(-28).map((p) => ({ ...p, ds: p.value / (idx[dow(p.date)] || 1) }));
  const m = recent.length;
  const xs = recent.map((_, i) => i);
  const xm = (m - 1) / 2;
  const ym = recent.reduce((a, p) => a + p.ds, 0) / m;
  let num = 0;
  let den = 0;
  recent.forEach((p, i) => {
    num += (xs[i] - xm) * (p.ds - ym);
    den += (xs[i] - xm) ** 2;
  });
  const slope = den ? num / den : 0;
  const level = ym + slope * (m - 1 - xm);
  const resid = recent.map((p, i) => p.value - (ym + slope * (i - xm)) * idx[dow(p.date)]);
  const sigma = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / Math.max(1, m - 2));
  return horizon.map((date, h) => {
    const damp = (1 - Math.pow(0.9, h + 1)) / 0.1; // damped cumulative trend
    const mid = Math.max(0, (level + slope * 0.5 * damp) * idx[dow(date)]);
    const w = Z80 * sigma * Math.sqrt(1 + h / 7);
    return { date, mid, lo: Math.max(0, mid - w), hi: mid + w };
  });
}

/** Fit revenue = a · spend^b on daily points (log-log least squares, b clamped). */
export function fitResponse(points: Array<[number, number]>) {
  const pts = points.filter(([s, r]) => s > 0 && r > 0);
  const avgS = points.reduce((a, p) => a + p[0], 0) / Math.max(1, points.length);
  const avgR = points.reduce((a, p) => a + p[1], 0) / Math.max(1, points.length);
  let b = 0.7;
  if (pts.length >= 10) {
    const lx = pts.map((p) => Math.log(p[0]));
    const ly = pts.map((p) => Math.log(p[1]));
    const mx = lx.reduce((a, v) => a + v, 0) / lx.length;
    const my = ly.reduce((a, v) => a + v, 0) / ly.length;
    let num = 0;
    let den = 0;
    lx.forEach((x, i) => {
      num += (x - mx) * (ly[i] - my);
      den += (x - mx) ** 2;
    });
    if (den > 0) b = num / den;
  }
  b = Math.min(1, Math.max(0.25, b));
  const a = avgS > 0 ? avgR / Math.pow(avgS, b) : 0;
  return { a, b, avgSpend: avgS, avgRevenue: avgR };
}

