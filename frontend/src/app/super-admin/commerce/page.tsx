'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  DollarSign,
  TrendingDown,
  Undo2,
  Truck,
  PackageCheck,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { SaCard, SaPageHeader, SaSpinner, SaAvatar } from '../_components/sa-ui';

interface Courier {
  courier: string;
  courierName: string;
  total: number;
  delivered: number;
  failed: number;
  returned: number;
  inTransit: number;
  deliveryRate: number | null;
  deliveredAmount: number;
  codOutstanding: number;
}
interface Tenant {
  id: number;
  name: string;
  currency: string | null;
  gross: number;
  cancelled: number;
  returned: number;
  net: number;
  orders: number;
  ordersActive: number;
  shipped: number;
  delivered: number;
  failed: number;
  returnedCount: number;
  inTransit: number;
  deliveryRate: number | null;
  deliveredAmount: number;
  codOutstanding: number;
}
interface CurrencyAgg {
  gross: number;
  net: number;
  cancelled: number;
  returned: number;
  orders: number;
  ordersActive: number;
}
interface Counts {
  orders: number;
  ordersActive: number;
  shipped: number;
  delivered: number;
  failed: number;
  returned: number;
  inTransit: number;
  deliveryRate: number | null;
  returnRate: number | null;
}
interface Commerce {
  range: { from: string; to: string };
  overall: { byCurrency: Record<string, CurrencyAgg>; counts: Counts };
  couriers: Courier[];
  perTenant: Tenant[];
}
interface TenantDrill {
  stores: Array<{
    storeId: number | null;
    label: string;
    provider: string | null;
    currency: string | null;
    gross: number;
    cancelled: number;
    returned: number;
    net: number;
    orders: number;
    ordersActive: number;
  }>;
  couriers: Courier[];
}

type Preset = 'today' | '7d' | '30d' | 'month' | 'custom';

function rangeFor(preset: Preset, customFrom: string, customTo: string): { from: string; to: string } {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (preset === 'today') return { from: startOfToday.toISOString(), to: end.toISOString() };
  if (preset === '7d') return { from: new Date(startOfToday.getTime() - 6 * 86_400_000).toISOString(), to: end.toISOString() };
  if (preset === 'month') return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), to: end.toISOString() };
  if (preset === 'custom' && customFrom && customTo) {
    return {
      from: new Date(`${customFrom}T00:00:00Z`).toISOString(),
      to: new Date(`${customTo}T23:59:59Z`).toISOString(),
    };
  }
  return { from: new Date(startOfToday.getTime() - 29 * 86_400_000).toISOString(), to: end.toISOString() };
}

const money = (cur: string | null, v: number) => `${cur ?? 'PKR'} ${Math.round(v).toLocaleString()}`;
const rate = (v: number | null) => (v == null ? '—' : `${v}%`);

export default function SuperAdminCommercePage() {
  const router = useRouter();
  const [preset, setPreset] = useState<Preset>('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState<Commerce | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [drill, setDrill] = useState<Record<number, TenantDrill | 'loading'>>({});

  const range = useMemo(() => rangeFor(preset, customFrom, customTo), [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await apiFetch<Commerce>('/super-admin/commerce', {
        params: { from: range.from, to: range.to },
        noOnboardingRedirect: true,
        timeout: 40000,
      });
      setData(d);
      setDrill({});
      setExpanded(null);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        router.replace('/super-admin/login');
        return;
      }
      setError(e instanceof ApiError ? e.userMessage : 'Failed to load commerce analytics (timed out). Retry.');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (id: number) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!drill[id]) {
      setDrill((m) => ({ ...m, [id]: 'loading' }));
      try {
        const d = await apiFetch<TenantDrill>(`/super-admin/commerce/tenant/${id}`, {
          params: { from: range.from, to: range.to },
          noOnboardingRedirect: true,
        });
        setDrill((m) => ({ ...m, [id]: d }));
      } catch {
        setDrill((m) => {
          const next = { ...m };
          delete next[id];
          return next;
        });
      }
    }
  };

  const currencies = data ? Object.entries(data.overall.byCurrency).sort((a, b) => b[1].gross - a[1].gross) : [];
  const primary = currencies[0];

  return (
    <div className="sa-content">
      <SaPageHeader
        title="Commerce"
        subtitle="Sales, net revenue and fulfillment across all tenants. Sales by order date; fulfillment by dispatch date."
        actions={
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div className="sa-seg" role="group" aria-label="Range">
              {(['today', '7d', '30d', 'month'] as Preset[]).map((p) => (
                <button key={p} className={preset === p ? 'on' : ''} onClick={() => setPreset(p)}>
                  {p === 'today' ? 'Today' : p === 'month' ? 'Month' : p}
                </button>
              ))}
              <button className={preset === 'custom' ? 'on' : ''} onClick={() => setPreset('custom')}>Custom</button>
            </div>
            {preset === 'custom' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="date" className="sa-input" style={{ width: 'auto' }} value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
                <span className="sa-faint">→</span>
                <input type="date" className="sa-input" style={{ width: 'auto' }} value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
              </div>
            )}
          </div>
        }
      />

      {error && (
        <div className="sa-alert-error">
          {error}
          <button className="sa-btn" style={{ marginLeft: 12 }} onClick={() => load()}>Retry</button>
        </div>
      )}

      {loading && !data ? (
        <SaSpinner />
      ) : !data ? null : (
        <>
          {/* KPI tiles */}
          <section className="sa-kpis">
            <Tile label="Net sales" icon={DollarSign} tone="green"
              value={primary ? money(primary[0], primary[1].net) : 'PKR 0'}
              foot={currencies.length > 1 ? `+${currencies.length - 1} more currency` : (primary ? `${primary[1].orders.toLocaleString()} orders` : '')} />
            <Tile label="Gross sales" icon={DollarSign} tone="slate"
              value={primary ? money(primary[0], primary[1].gross) : 'PKR 0'}
              foot={primary ? `${primary[1].ordersActive.toLocaleString()} live orders` : ''} />
            <Tile label="Cancelled" icon={TrendingDown} tone="amber"
              value={primary ? money(primary[0], primary[1].cancelled) : 'PKR 0'} />
            <Tile label="Returned (RTO)" icon={Undo2} tone="red"
              value={primary ? money(primary[0], primary[1].returned) : 'PKR 0'}
              foot={`${data.overall.counts.returned.toLocaleString()} parcels`} />
            <Tile label="Delivery rate" icon={PackageCheck} tone="green"
              value={rate(data.overall.counts.deliveryRate)}
              foot={`${data.overall.counts.delivered.toLocaleString()} / ${data.overall.counts.shipped.toLocaleString()} shipped`} />
            <Tile label="Return rate" icon={Truck} tone="amber"
              value={rate(data.overall.counts.returnRate)}
              foot={`${data.overall.counts.inTransit.toLocaleString()} in transit`} />
          </section>

          {currencies.length > 1 && (
            <SaCard title="Sales by currency">
              <div className="sa-table-wrap">
                <table className="sa-table">
                  <thead><tr><th>Currency</th><th className="n">Gross</th><th className="n">Cancelled</th><th className="n">Returned</th><th className="n">Net</th><th className="n">Orders</th></tr></thead>
                  <tbody>
                    {currencies.map(([cur, b]) => (
                      <tr key={cur}>
                        <td style={{ fontWeight: 600 }}>{cur}</td>
                        <td className="n">{money(cur, b.gross)}</td>
                        <td className="n" style={{ color: 'var(--sa-warn)' }}>{money(cur, b.cancelled)}</td>
                        <td className="n" style={{ color: 'var(--sa-crit)' }}>{money(cur, b.returned)}</td>
                        <td className="n" style={{ fontWeight: 600, color: 'var(--sa-good)' }}>{money(cur, b.net)}</td>
                        <td className="n">{b.orders.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SaCard>
          )}

          {/* Fulfillment funnel */}
          <SaCard title="Fulfillment funnel" right={`${data.overall.counts.shipped.toLocaleString()} dispatched`}>
            <Funnel c={data.overall.counts} />
          </SaCard>

          {/* Couriers */}
          <SaCard title="Courier performance" right="all tenants" bodyClassName="">
            <CourierTable couriers={data.couriers} />
          </SaCard>

          {/* Per-tenant */}
          <SaCard title="By tenant" right={`${data.perTenant.length} with activity`} bodyClassName="">
            <div className="sa-table-wrap">
              <table className="sa-table" style={{ minWidth: 820 }}>
                <thead>
                  <tr>
                    <th style={{ width: 28 }} /><th>Tenant</th><th className="n">Gross</th>
                    <th className="n">Net</th><th className="n">Orders</th>
                    <th className="n">Shipped</th><th className="n">Delivery</th><th className="n">Returns</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perTenant.length === 0 ? (
                    <tr><td colSpan={8} className="sa-faint" style={{ textAlign: 'center', padding: 40 }}>No commerce activity in this range.</td></tr>
                  ) : (
                    data.perTenant.map((t) => {
                      const open = expanded === t.id;
                      const d = drill[t.id];
                      return (
                        <Fragment key={t.id}>
                          <tr style={{ cursor: 'pointer' }} onClick={() => toggle(t.id)}>
                            <td>{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <SaAvatar label={t.name} />
                                <span style={{ fontWeight: 600 }}>{t.name}</span>
                              </div>
                            </td>
                            <td className="n">{money(t.currency, t.gross)}</td>
                            <td className="n" style={{ fontWeight: 600, color: 'var(--sa-good)' }}>{money(t.currency, t.net)}</td>
                            <td className="n">{t.orders.toLocaleString()}</td>
                            <td className="n">{t.shipped.toLocaleString()}</td>
                            <td className="n">{rate(t.deliveryRate)}</td>
                            <td className="n" style={{ color: t.returnedCount > 0 ? 'var(--sa-crit)' : 'var(--sa-fg-faint)' }}>{t.returnedCount.toLocaleString()}</td>
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={8} style={{ background: 'var(--sa-surface-2)', padding: 16 }}>
                                {d === 'loading' || !d ? (
                                  <SaSpinner pad={16} />
                                ) : (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                                    <div>
                                      <h4 style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 600 }} className="sa-muted">Stores</h4>
                                      <div className="sa-table-wrap" style={{ background: 'var(--sa-surface)', borderRadius: 8, border: '1px solid var(--sa-border)' }}>
                                        <table className="sa-table">
                                          <thead><tr><th>Store</th><th className="n">Gross</th><th className="n">Net</th><th className="n">Orders</th></tr></thead>
                                          <tbody>
                                            {d.stores.map((s) => (
                                              <tr key={String(s.storeId)}>
                                                <td>{s.label}{s.provider ? <span className="sub"> · {s.provider}</span> : null}</td>
                                                <td className="n">{money(s.currency, s.gross)}</td>
                                                <td className="n" style={{ fontWeight: 600 }}>{money(s.currency, s.net)}</td>
                                                <td className="n">{s.orders.toLocaleString()}</td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    </div>
                                    <div>
                                      <h4 style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 600 }} className="sa-muted">Couriers</h4>
                                      <div style={{ background: 'var(--sa-surface)', borderRadius: 8, border: '1px solid var(--sa-border)' }}>
                                        <CourierTable couriers={d.couriers} />
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </SaCard>
        </>
      )}
    </div>
  );
}

function Tile({
  label, value, icon: Icon, tone, foot,
}: {
  label: string; value: string; icon: typeof DollarSign; tone: 'slate' | 'green' | 'amber' | 'red'; foot?: string;
}) {
  return (
    <div className="sa-tile">
      <div className="sa-tile-top">
        <span className={`sa-tile-ico sa-ico-${tone}`}><Icon size={15} /></span>
        <span className="sa-tile-lab">{label}</span>
      </div>
      <div className="sa-tile-val" style={{ fontSize: 20 }}>{value}</div>
      {foot && <div className="sa-tile-foot"><span className="sa-faint">{foot}</span></div>}
    </div>
  );
}

function Funnel({ c }: { c: Counts }) {
  const segs = [
    { label: 'Delivered', v: c.delivered, color: 'var(--sa-good)' },
    { label: 'In transit', v: c.inTransit, color: 'var(--sa-info)' },
    { label: 'Failed', v: c.failed, color: 'var(--sa-warn)' },
    { label: 'Returned', v: c.returned, color: 'var(--sa-crit)' },
  ];
  const total = Math.max(1, segs.reduce((s, x) => s + x.v, 0));
  return (
    <>
      <div className="sa-statusbar" style={{ height: 16 }}>
        {segs.map((s) => (s.v > 0 ? <span key={s.label} style={{ background: s.color, width: `${(s.v / total) * 100}%`, display: 'block' }} title={`${s.label}: ${s.v}`} /> : null))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginTop: 14 }}>
        {segs.map((s) => (
          <span key={s.label} style={{ fontSize: 13 }} className="sa-muted">
            <i style={{ width: 9, height: 9, borderRadius: 3, display: 'inline-block', marginRight: 6, background: s.color, verticalAlign: 'middle' }} />
            {s.label} <b style={{ color: 'var(--sa-fg)', fontVariantNumeric: 'tabular-nums' }}>{s.v.toLocaleString()}</b>
          </span>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 13 }} className="sa-muted">
          Delivery rate <b style={{ color: 'var(--sa-good)' }}>{rate(c.deliveryRate)}</b>
        </span>
      </div>
    </>
  );
}

function CourierTable({ couriers }: { couriers: Courier[] }) {
  if (couriers.length === 0) return <div className="sa-card-body sa-faint" style={{ textAlign: 'center' }}>No parcels dispatched in this range.</div>;
  return (
    <div className="sa-table-wrap">
      <table className="sa-table" style={{ minWidth: 640 }}>
        <thead>
          <tr>
            <th>Courier</th><th className="n">Dispatched</th><th className="n">Delivered</th>
            <th className="n">Failed</th><th className="n">Returned</th><th className="n">In transit</th>
            <th className="n">Delivery</th><th className="n">COD out</th>
          </tr>
        </thead>
        <tbody>
          {couriers.map((c) => (
            <tr key={c.courier}>
              <td style={{ fontWeight: 600 }}>{c.courierName}</td>
              <td className="n">{c.total.toLocaleString()}</td>
              <td className="n" style={{ color: 'var(--sa-good)' }}>{c.delivered.toLocaleString()}</td>
              <td className="n" style={{ color: c.failed > 0 ? 'var(--sa-warn)' : 'var(--sa-fg-faint)' }}>{c.failed.toLocaleString()}</td>
              <td className="n" style={{ color: c.returned > 0 ? 'var(--sa-crit)' : 'var(--sa-fg-faint)' }}>{c.returned.toLocaleString()}</td>
              <td className="n">{c.inTransit.toLocaleString()}</td>
              <td className="n" style={{ fontWeight: 600 }}>{rate(c.deliveryRate)}</td>
              <td className="n sa-faint">{c.codOutstanding > 0 ? Math.round(c.codOutstanding).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
