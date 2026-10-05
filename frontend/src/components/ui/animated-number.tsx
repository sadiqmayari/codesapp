'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A number that rolls to its new value instead of snapping — counts UP when the
 * value rises and DOWN when it falls, so a live change reads as a scrolling
 * figure (the direction is the sign of the tween). Format-agnostic: pass a
 * `format` fn so money/percent/plain integers all animate while keeping their
 * exact presentation. Honors `prefers-reduced-motion` (snaps, no tween) and
 * animates from 0 on first mount for the dashboard count-up feel.
 */
export function AnimatedNumber({
  value,
  format = (v) => Math.round(v).toLocaleString(),
  duration = 700,
  className,
  animateOnMount = true,
}: {
  value: number;
  format?: (v: number) => string;
  duration?: number;
  className?: string;
  animateOnMount?: boolean;
}) {
  const [display, setDisplay] = useState(animateOnMount ? 0 : value);
  // The value the current animation starts FROM (also the last settled value).
  const fromRef = useRef(animateOnMount ? 0 : value);
  const rafRef = useRef<number | null>(null);
  const firstRef = useRef(true);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const onFirst = firstRef.current;
    firstRef.current = false;

    // Nothing to do if the value hasn't actually moved (ignoring the mount case).
    if (!onFirst && value === fromRef.current) return;
    if (onFirst && !animateOnMount) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    if (reduce) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }

    const from = fromRef.current;
    const to = value;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      if (t < 1) {
        setDisplay(from + (to - from) * eased);
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
        setDisplay(to);
      }
    };
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration, animateOnMount]);

  return <span className={className}>{format(display)}</span>;
}
