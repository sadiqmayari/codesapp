'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, X } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useSocket } from '@/context/socket-context';
import { useAuth } from '@/context/auth-context';
import { cn } from '@/lib/utils';

/**
 * Phase 4.5 — sticky banner above the navbar that warns the tenant when a
 * usage limit crosses 90 / 99 / 100%. Hydrates from
 * `GET /api/billing/usage-warnings` on mount, then updates live via the
 * `usage.warning` socket event. Per-SESSION dismissal (sessionStorage)
 * keyed on `{companyId}:{period}:{dim}:{threshold}` — reappears next
 * session as long as the condition holds. Renders nothing when the list
 * is empty or every active warning is dismissed.
 */

export interface UsageWarning {
  dim: 'contacts' | 'templates';
  threshold: '90' | '99' | '100';
  pct: number;
  current: number;
  limit: number;
  severity: 'warn' | 'critical';
}

const DIM_LABEL: Record<UsageWarning['dim'], string> = {
  contacts: 'contacts',
  templates: 'templates',
};

function keyOf(companyId: number, w: UsageWarning, period: string): string {
  return `${companyId}:${period}:${w.dim}:${w.threshold}`;
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

interface Props {
  /**
   * Lets the parent shell react to the highest severity currently active
   * (used to pulse the navbar chip at ≥99%). Receives null when nothing
   * is active or everything is dismissed.
   */
  onTopSeverityChange?: (severity: 'warn' | 'critical' | null) => void;
}

export function UsageWarningBanner({ onTopSeverityChange }: Props) {
  const { on } = useSocket();
  const { user } = useAuth();
  const companyId = user?.company?.id ?? 0;

  const [warnings, setWarnings] = useState<UsageWarning[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  // Hydrate from sessionStorage on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.sessionStorage.getItem('ca_usage_dismissed');
      if (raw) setDismissed(new Set(JSON.parse(raw)));
    } catch {
      /* ignore */
    }
  }, []);

  const persistDismissed = useCallback((next: Set<string>) => {
    try {
      window.sessionStorage.setItem(
        'ca_usage_dismissed',
        JSON.stringify(Array.from(next)),
      );
    } catch {
      /* ignore */
    }
  }, []);

  // Initial fetch.
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    apiFetch<UsageWarning[]>('/billing/usage-warnings', {
      noOnboardingRedirect: true,
    })
      .then((data) => {
        if (!cancelled) setWarnings(data);
      })
      .catch(() => {
        // 401/412/etc. — the layout has stronger gates; we silently no-op.
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Live updates.
  useEffect(() => {
    const off = on('usage.warning', (incoming: UsageWarning) => {
      setWarnings((prev) => {
        // Replace any same-dim warning (keep only the highest threshold).
        const filtered = prev.filter((w) => w.dim !== incoming.dim);
        return [...filtered, incoming];
      });
    });
    return () => off();
  }, [on]);

  // Active = not dismissed for this session/period.
  const active = useMemo(() => {
    const period = currentPeriod();
    return warnings.filter((w) => !dismissed.has(keyOf(companyId, w, period)));
  }, [warnings, dismissed, companyId]);

  // Notify parent of the highest severity (for the navbar pulse chip).
  useEffect(() => {
    const top = active.find((w) => w.severity === 'critical')
      ? 'critical'
      : active.length
        ? 'warn'
        : null;
    onTopSeverityChange?.(top);
  }, [active, onTopSeverityChange]);

  if (active.length === 0) return null;

  // We show ONE banner — the most severe warning (red 100/99 wins over yellow 90).
  const top =
    active.find((w) => w.threshold === '100') ??
    active.find((w) => w.threshold === '99') ??
    active.find((w) => w.threshold === '90')!;

  const critical = top.severity === 'critical';

  const dismiss = () => {
    const next = new Set(dismissed);
    next.add(keyOf(companyId, top, currentPeriod()));
    setDismissed(next);
    persistDismissed(next);
  };

  return (
    <div
      role="status"
      className={cn(
        'w-full border-b text-sm flex items-center gap-3 px-4 py-2',
        critical
          ? 'bg-gradient-to-r from-red-500 to-red-600 text-white border-red-700 animate-pulse'
          : 'bg-gradient-to-r from-amber-100 to-amber-50 text-amber-900 border-amber-200',
      )}
    >
      <AlertTriangle
        size={16}
        className={critical ? 'text-white shrink-0' : 'text-amber-700 shrink-0'}
      />
      <div className="flex-1 min-w-0">
        {top.threshold === '100' ? (
          <span>
            <strong>You have reached your {DIM_LABEL[top.dim]} quota</strong>{' '}
            ({top.current.toLocaleString()} / {top.limit.toLocaleString()}).
            Service may be restricted depending on your plan policy.
          </span>
        ) : top.threshold === '99' ? (
          <span>
            <strong>
              Critical: 99% of your {DIM_LABEL[top.dim]} quota used
            </strong>{' '}
            ({top.current.toLocaleString()} / {top.limit.toLocaleString()}).
            Service will be restricted at 100%.
          </span>
        ) : (
          <span>
            You&apos;ve used <strong>90%</strong> of your{' '}
            {DIM_LABEL[top.dim]} quota (
            {top.current.toLocaleString()} / {top.limit.toLocaleString()}).
            Consider upgrading before you hit the cap.
          </span>
        )}
      </div>
      <Link
        href="/billing"
        className={cn(
          'shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold border',
          critical
            ? 'bg-white/20 hover:bg-white/30 border-white/40 text-white'
            : 'bg-white hover:bg-amber-50 border-amber-300 text-amber-800',
        )}
      >
        View usage
      </Link>
      <button
        onClick={dismiss}
        className={cn(
          'shrink-0 rounded-md p-1 text-xs',
          critical ? 'hover:bg-white/20' : 'hover:bg-amber-200',
        )}
        aria-label="Dismiss for this session"
        title="Dismiss for this session"
      >
        <X size={14} />
      </button>
    </div>
  );
}
