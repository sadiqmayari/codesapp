'use client';

import type { LucideIcon } from 'lucide-react';

/** Section card with a header and optional right-side label or action chip. */
export function SaCard({
  title,
  right,
  chip,
  children,
  bodyClassName,
}: {
  title?: string;
  right?: React.ReactNode;
  chip?: React.ReactNode;
  children: React.ReactNode;
  bodyClassName?: string;
}) {
  return (
    <section className="sa-card">
      {(title || right || chip) && (
        <div className="sa-card-head">
          {title && <h3>{title}</h3>}
          {chip ? (
            <span className="chip">{chip}</span>
          ) : right ? (
            <span className="r">{right}</span>
          ) : null}
        </div>
      )}
      {bodyClassName === '' ? children : (
        <div className={bodyClassName ?? 'sa-card-body'}>{children}</div>
      )}
    </section>
  );
}

type Tone = 'slate' | 'green' | 'amber' | 'red' | 'info';

/** Big-number KPI tile with an icon and optional footer / sparkline. */
export function SaTile({
  label,
  value,
  icon: Icon,
  tone = 'slate',
  foot,
  href,
}: {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  tone?: Tone;
  foot?: React.ReactNode;
  href?: string;
}) {
  const inner = (
    <>
      <div className="sa-tile-top">
        <span className={`sa-tile-ico sa-ico-${tone}`}>
          <Icon size={15} />
        </span>
        <span className="sa-tile-lab">{label}</span>
      </div>
      <div className="sa-tile-val">{value}</div>
      {foot && <div className="sa-tile-foot">{foot}</div>}
    </>
  );
  if (href) {
    return (
      <a className="sa-tile" href={href}>
        {inner}
      </a>
    );
  }
  return <div className="sa-tile">{inner}</div>;
}

const STATUS_MAP: Record<string, { cls: string; label: string }> = {
  active: { cls: 'good', label: 'Active' },
  pending: { cls: 'warn', label: 'Pending' },
  suspended: { cls: 'crit', label: 'Suspended' },
};

/** Tenant activation-status pill (with grace awareness). */
export function SaStatusPill({
  status,
  graceUntil,
}: {
  status: string;
  graceUntil?: string | null;
}) {
  if (
    status === 'suspended' &&
    graceUntil &&
    new Date(graceUntil).getTime() > Date.now()
  ) {
    return <span className="sa-pill warn">Grace</span>;
  }
  const m = STATUS_MAP[status] ?? { cls: 'slate', label: status };
  return <span className={`sa-pill ${m.cls}`}>{m.label}</span>;
}

/** Deterministic colored initials avatar (stable per label). */
const AV_COLORS = [
  '#16a34a', '#2563eb', '#d97706', '#7c3aed', '#0d9488', '#dc2626', '#db2777', '#0891b2',
];
export function SaAvatar({
  label,
  size = 30,
}: {
  label: string | null | undefined;
  size?: number;
}) {
  const s = (label ?? '?').trim();
  const initial = s ? s[0].toUpperCase() : '?';
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  const color = AV_COLORS[hash % AV_COLORS.length];
  return (
    <span
      className="sa-avatar"
      style={{ width: size, height: size, background: color, fontSize: size * 0.4 }}
    >
      {initial}
    </span>
  );
}

export function SaSpinner({ pad = 40 }: { pad?: number }) {
  return (
    <div style={{ padding: pad, display: 'flex', justifyContent: 'center' }}>
      <div className="sa-spinner" />
    </div>
  );
}

export function SaPageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ marginRight: 'auto' }}>
        <h1 className="sa-h1">{title}</h1>
        {subtitle && <p className="sa-sub">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}
