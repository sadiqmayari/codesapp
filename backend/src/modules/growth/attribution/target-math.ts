/** Monthly target pacing — pure, unit-tested (target-math.spec.ts). */

/** Standard normal CDF (Abramowitz–Stegun). */
export function phi(z: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** Pure pacing maths (unit-tested). */
export function pace(input: {
  target: number;
  soFar: number;
  daysLeft: number;
  p10: number;
  p50: number;
  p90: number;
  recentPerDay: number;
}) {
  const { target, soFar, daysLeft, p10, p50, p90, recentPerDay } = input;
  const needPerDay = daysLeft > 0 ? Math.max(0, (target - soFar) / daysLeft) : 0;
  const sigma = Math.max(1, (p90 - p10) / 2.563);
  const chance = target <= soFar ? 1 : daysLeft <= 0 ? 0 : phi((p50 - target) / sigma);
  return {
    target,
    soFar,
    daysLeft,
    needPerDay,
    recentPerDay,
    projected: { p10, p50, p90 },
    gap: Math.max(0, target - p50),
    chance: Math.round(chance * 100),
    status: (chance >= 0.7 ? 'on_track' : chance >= 0.4 ? 'at_risk' : 'off_track') as 'on_track' | 'at_risk' | 'off_track',
  };
}

