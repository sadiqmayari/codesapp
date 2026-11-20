'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, FileDown, Lock, Plus, RotateCcw, Trash2, Wallet } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SideSheet } from '@/components/ui/side-sheet';
import { Modal, ConfirmDialog } from '@/components/ui/modal';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonCards, SkeletonRows } from '@/components/ui/skeleton';
import {
  ADJUSTMENT_LABELS,
  addAdjustment,
  approvePayroll,
  deleteAdjustment,
  downloadPayrollCsv,
  fmtHours,
  fmtMoney,
  getAdjustments,
  getPayroll,
  markPayrollPaid,
  reopenPayroll,
  type Adjustment,
  type AdjustmentKind,
  type Payslip,
  type PayrollResult,
} from '@/lib/attendance';
import { cn, zonedMonthString } from '@/lib/utils';
import { Field, MonthInput, errMsg, inputCls } from './shared';

type Html2PdfWorker = { set: (o: unknown) => Html2PdfWorker; from: (el: HTMLElement) => Html2PdfWorker; save: () => Promise<void> };

const monthLabel = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Payslip in a side sheet; "Download PDF" renders the sheet to a real file. */
export function PayslipSheet({
  slip,
  currency,
  onClose,
  footer,
}: {
  slip: Payslip | null;
  currency: string;
  onClose: () => void;
  footer?: React.ReactNode;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const pdf = async () => {
    if (!ref.current || !slip) return;
    setBusy(true);
    try {
      const mod = await import('html2pdf.js');
      const html2pdf = ((mod as { default?: () => Html2PdfWorker }).default ?? (mod as unknown as () => Html2PdfWorker)) as () => Html2PdfWorker;
      await html2pdf()
        .set({
          margin: [10, 10, 10, 10],
          filename: `payslip-${slip.name.replace(/[^a-z0-9]+/gi, '-')}-${slip.month}.pdf`,
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        })
        .from(ref.current)
        .save();
    } catch {
      toast.error('Could not create the PDF');
    } finally {
      setBusy(false);
    }
  };
  if (!slip) return <SideSheet open={false} onClose={onClose} title="">{null}</SideSheet>;
  const earn = slip.lines.filter((l) => l.kind === 'earning');
  const ded = slip.lines.filter((l) => l.kind === 'deduction');
  const m = (n: number) => fmtMoney(n, currency);
  return (
    <SideSheet
      open
      onClose={onClose}
      title={slip.name}
      subtitle={`Payslip · ${monthLabel(slip.month)}`}
      width="lg"
      footer={
        <div className="flex w-full items-center gap-2">
          {footer}
          <span className="flex-1" />
          <Button variant="secondary" loading={busy} onClick={pdf}>
            <FileDown size={16} /> Download PDF
          </Button>
        </div>
      }
    >
      {/* Rendered to PDF — keep it light-themed regardless of app theme. */}
      <div ref={ref} className="rounded-xl border border-gray-200 bg-white text-gray-900" style={{ colorScheme: 'light' }}>
        <div className="flex flex-wrap justify-between gap-3 rounded-t-xl bg-[#0E1A2B] px-5 py-4 text-white">
          <div>
            <p className="text-xs opacity-70">{user?.company?.name ?? 'Payslip'}</p>
            <p className="text-lg font-bold">{slip.name}</p>
            <p className="text-xs opacity-70">
              {slip.role} · {slip.periodFrom} to {slip.periodTo}
              {slip.prorated ? ' (part month)' : ''}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs opacity-70">Net pay</p>
            <p className="text-2xl font-bold tabular-nums">{m(slip.netPayable)}</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 border-b border-gray-200 px-5 py-3 text-center text-xs sm:grid-cols-6">
          {[
            ['Work days', slip.scheduledDays],
            ['Present', slip.present + (slip.halfDay ? ` +${slip.halfDay}½` : '')],
            ['Absent', slip.absent],
            ['Leave', slip.paidLeave + slip.unpaidLeave],
            ['Late', slip.lateCount],
            ['Hours', fmtHours(slip.workedMinutes)],
          ].map(([k, v]) => (
            <div key={String(k)}>
              <p className="text-gray-500">{k}</p>
              <p className="font-bold tabular-nums">{v}</p>
            </div>
          ))}
        </div>
        <div className="px-5 py-3">
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-gray-500">Earnings</p>
          {earn.map((l, i) => (
            <div key={i} className="flex justify-between gap-3 border-b border-dashed border-gray-200 py-1.5 text-sm">
              <span>
                {l.label}
                {l.detail && <span className="ml-2 text-xs text-gray-500">{l.detail}</span>}
              </span>
              <span className="tabular-nums">{m(l.amount)}</span>
            </div>
          ))}
          <div className="flex justify-between py-1.5 text-sm font-semibold">
            <span>Gross</span>
            <span className="tabular-nums">{m(slip.gross)}</span>
          </div>
          <p className="mb-1 mt-3 text-xs font-bold uppercase tracking-wide text-gray-500">Deductions</p>
          {ded.length ? (
            ded.map((l, i) => (
              <div key={i} className="flex justify-between gap-3 border-b border-dashed border-gray-200 py-1.5 text-sm">
                <span>
                  {l.label}
                  {l.detail && <span className="ml-2 text-xs text-gray-500">{l.detail}</span>}
                </span>
                <span className="tabular-nums text-red-700">−{m(l.amount)}</span>
              </div>
            ))
          ) : (
            <p className="py-1.5 text-sm text-gray-500">None</p>
          )}
        </div>
        <div className="flex justify-between rounded-b-xl bg-emerald-50 px-5 py-3 text-base font-bold text-emerald-800">
          <span>Net pay</span>
          <span className="tabular-nums">{m(slip.netPayable)}</span>
        </div>
      </div>
      {slip.unmarkedDays > 0 && (
        <p className="mt-3 text-xs text-amber-700">{slip.unmarkedDays} past work day(s) have no attendance record. They are paid; mark them in the Daily grid if they were absences.</p>
      )}
    </SideSheet>
  );
}

function AdjustmentModal({
  open,
  month,
  people,
  initialUser,
  onClose,
  onSaved,
}: {
  open: boolean;
  month: string;
  people: { userId: number; name: string }[];
  initialUser: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [userId, setUserId] = useState<number | null>(null);
  const [kind, setKind] = useState<AdjustmentKind>('bonus');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setUserId(initialUser ?? people[0]?.userId ?? null);
      setKind('bonus');
      setLabel('');
      setAmount('');
    }
  }, [open, initialUser, people]);
  const save = async () => {
    if (!userId) return;
    setBusy(true);
    try {
      await addAdjustment({ userId, month, kind, label: label || ADJUSTMENT_LABELS[kind], amount: Number(amount) });
      toast.success('Adjustment added');
      onSaved();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Add adjustment · ${monthLabel(month)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!userId || !(Number(amount) > 0)} onClick={save}>Add</Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Member" htmlFor="adj-user">
          <select id="adj-user" className={inputCls} value={userId ?? ''} onChange={(e) => setUserId(Number(e.target.value))}>
            {people.map((p) => (
              <option key={p.userId} value={p.userId}>{p.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Type" htmlFor="adj-kind" hint={kind === 'bonus' || kind === 'reimbursement' ? 'Adds to pay.' : 'Taken off pay.'}>
          <select id="adj-kind" className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as AdjustmentKind)}>
            {Object.entries(ADJUSTMENT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </Field>
        <Field label="Label on the payslip" htmlFor="adj-label">
          <input id="adj-label" className={inputCls} value={label} placeholder={ADJUSTMENT_LABELS[kind]} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Amount" htmlFor="adj-amount">
          <input id="adj-amount" type="number" min="0" step="any" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export default function PayrollTab() {
  const toast = useToast();
  const { user } = useAuth();
  const isOwner = user?.role === 'owner';
  const [month, setMonth] = useState(() => zonedMonthString());
  const [data, setData] = useState<PayrollResult | null>(null);
  const [adjs, setAdjs] = useState<Adjustment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Payslip | null>(null);
  const [adjFor, setAdjFor] = useState<number | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<'approve' | 'paid' | 'reopen' | null>(null);
  const [busy, setBusy] = useState(false);
  const [csvBusy, setCsvBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    Promise.all([getPayroll(month), getAdjustments(month)])
      .then(([p, a]) => {
        setData(p);
        setAdjs(a);
      })
      .catch((e) => setError(errMsg(e, 'Could not load payroll')));
  }, [month]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const cur = data?.policy.currency ?? 'Rs';
  const money = (n: number) => fmtMoney(n, cur);
  const status = data?.run?.status ?? 'draft';
  const locked = !!data?.locked;

  const runAction = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const fn = confirm === 'approve' ? approvePayroll : confirm === 'paid' ? markPayrollPaid : reopenPayroll;
      setData(await fn(month));
      toast.success(confirm === 'approve' ? 'Payroll approved and locked' : confirm === 'paid' ? 'Marked as paid' : 'Payroll reopened');
      setConfirm(null);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const steps: { key: string; label: string; done: boolean; current: boolean }[] = [
    { key: 'draft', label: 'Draft', done: status !== 'draft', current: status === 'draft' },
    { key: 'approved', label: 'Approved', done: status === 'paid', current: status === 'approved' },
    { key: 'paid', label: 'Paid', done: status === 'paid', current: false },
  ];

  const slipAdjs = open ? adjs.filter((a) => a.userId === open.userId) : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <MonthInput id="pay-month" value={month} onChange={setMonth} />
        <ol className="flex items-center gap-2 text-sm" aria-label="Payroll status">
          {steps.map((s, i) => (
            <li key={s.key} className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold',
                  s.done ? 'bg-brand-600 text-white' : s.current ? 'bg-ink text-surface' : 'bg-sunken text-muted',
                )}
              >
                {s.done ? <Check size={12} /> : i + 1}
              </span>
              <span className={cn('font-semibold', s.done || s.current ? 'text-ink' : 'text-muted')}>{s.label}</span>
              {i < steps.length - 1 && <span className="h-px w-6 bg-line" aria-hidden />}
            </li>
          ))}
        </ol>
        <span className="flex-1" />
        {!locked && (
          <Button variant="secondary" size="sm" onClick={() => setAdjFor(null)} disabled={!data?.rows.length}>
            <Plus size={14} /> Adjustment
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          loading={csvBusy}
          onClick={async () => {
            setCsvBusy(true);
            try {
              await downloadPayrollCsv(month);
            } catch (e) {
              toast.error(errMsg(e));
            } finally {
              setCsvBusy(false);
            }
          }}
        >
          <Download size={14} /> CSV
        </Button>
        {status === 'draft' && (
          <Button size="sm" disabled={!data?.rows.length} onClick={() => setConfirm('approve')}>
            <Lock size={14} /> Approve &amp; lock
          </Button>
        )}
        {status === 'approved' && (
          <Button size="sm" onClick={() => setConfirm('paid')}>
            <Wallet size={14} /> Mark paid
          </Button>
        )}
        {locked && isOwner && (
          <Button size="sm" variant="ghost" onClick={() => setConfirm('reopen')}>
            <RotateCcw size={14} /> Reopen
          </Button>
        )}
      </div>

      {locked && (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800">
          {monthLabel(month)} is {status}. These figures are a locked snapshot; later salary or policy changes don&apos;t affect them.
          {isOwner ? ' Reopen to recalculate.' : ''}
        </p>
      )}

      {error ? (
        <EmptyState title="Could not load payroll" description={error} action={<Button onClick={load}>Retry</Button>} />
      ) : !data ? (
        <>
          <SkeletonCards count={4} />
          <SkeletonRows rows={6} />
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ['Net payable', money(data.totals.net), `${data.totals.people} people`],
              ['Gross', money(data.totals.gross), 'Base + allowances + overtime + commission'],
              ['Commission', money(data.totals.commission), 'From commission plans'],
              ['Deductions', money(data.totals.deductions), 'Absence, late, statutory, advances'],
            ].map(([k, v, h]) => (
              <Card key={k} className="p-4">
                <p className="text-xs text-muted">{k}</p>
                <p className="text-xl font-bold tabular-nums text-ink">{v}</p>
                <p className="mt-0.5 text-xs text-muted">{h}</p>
              </Card>
            ))}
          </div>
          {!!data.hiddenCount && (
            <p className="rounded-lg border border-line bg-sunken px-3 py-2 text-xs text-muted">
              {data.hiddenCount} {data.hiddenCount === 1 ? 'person is' : 'people are'} hidden: admins and your own pay are managed by the owner.
            </p>
          )}
          <DataTable<Payslip>
            rows={data.rows}
            rowKey={(r) => r.userId}
            onRowClick={setOpen}
            rowLabel={(r) => `Open ${r.name}'s payslip`}
            emptyNode={<EmptyState compact icon={Wallet} title="No one to pay" description="Set salaries in Settings → Members." />}
            columns={[
              {
                key: 'name',
                header: 'Member',
                sortValue: (r) => r.name,
                render: (r) => (
                  <span className="font-medium text-ink">
                    {r.name}
                    {r.flexible && <Badge tone="violet" className="ml-1.5">Flex</Badge>}
                    {r.prorated && <Badge tone="info" className="ml-1.5">Part month</Badge>}
                    {r.salary === 0 && <Badge tone="warn" className="ml-1.5">No salary</Badge>}
                  </span>
                ),
              },
              { key: 'days', header: 'Days', align: 'right', render: (r) => `${r.present + r.halfDay * 0.5 + r.paidLeave}/${r.scheduledDays}` },
              { key: 'base', header: 'Base', align: 'right', sortValue: (r) => r.base, render: (r) => money(r.base) },
              { key: 'allow', header: 'Allowances', align: 'right', render: (r) => money(r.allowanceTotal) },
              { key: 'ot', header: 'Overtime', align: 'right', render: (r) => (r.overtimePay ? money(r.overtimePay) : '—') },
              { key: 'comm', header: 'Commission', align: 'right', sortValue: (r) => r.commission, render: (r) => (r.commission ? <span className="text-brand-700">{money(r.commission)}</span> : '—') },
              {
                key: 'adj',
                header: 'Adjust',
                align: 'right',
                render: (r) => {
                  const d = r.adjustmentsPlus - r.adjustmentsMinus;
                  return d ? <span className={d < 0 ? 'text-red-700' : 'text-brand-700'}>{d < 0 ? '−' : '+'}{money(Math.abs(d))}</span> : '—';
                },
              },
              { key: 'ded', header: 'Deductions', align: 'right', sortValue: (r) => r.deductions - r.adjustmentsMinus, render: (r) => { const d = r.deductions - r.adjustmentsMinus; return d ? <span className="text-red-700">−{money(d)}</span> : '—'; } },
              { key: 'net', header: 'Net', align: 'right', sortValue: (r) => r.netPayable, render: (r) => <b className="tabular-nums">{money(r.netPayable)}</b> },
            ]}
          />
        </>
      )}

      <PayslipSheet
        slip={open}
        currency={cur}
        onClose={() => setOpen(null)}
        footer={
          open && !locked ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => setAdjFor(open.userId)}>
                <Plus size={14} /> Adjustment
              </Button>
              {slipAdjs.map((a) => (
                <span key={a.id} className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-xs">
                  {a.label} {a.additive ? '+' : '−'}{money(a.amount)}
                  <button
                    type="button"
                    aria-label={`Remove ${a.label}`}
                    onClick={async () => {
                      try {
                        await deleteAdjustment(a.id);
                        const fresh = await getPayroll(month);
                        setData(fresh);
                        setAdjs(await getAdjustments(month));
                        setOpen(fresh.rows.find((x) => x.userId === a.userId) ?? null);
                      } catch (e) {
                        toast.error(errMsg(e));
                      }
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : undefined
        }
      />
      <AdjustmentModal
        open={adjFor !== undefined}
        month={month}
        people={data?.rows.map((r) => ({ userId: r.userId, name: r.name })) ?? []}
        initialUser={adjFor ?? null}
        onClose={() => setAdjFor(undefined)}
        onSaved={async () => {
          setAdjFor(undefined);
          try {
            const [fresh, a] = await Promise.all([getPayroll(month), getAdjustments(month)]);
            setData(fresh);
            setAdjs(a);
            if (open) setOpen(fresh.rows.find((x) => x.userId === open.userId) ?? null);
          } catch {
            load();
          }
        }}
      />
      <ConfirmDialog
        open={!!confirm}
        title={confirm === 'approve' ? `Approve ${monthLabel(month)} payroll?` : confirm === 'paid' ? 'Mark as paid?' : 'Reopen payroll?'}
        message={
          confirm === 'approve'
            ? 'This locks every payslip as it is now. Staff can then see their payslip. Attendance edits for this month are blocked until it is reopened.'
            : confirm === 'paid'
              ? 'Records that salaries for this month were paid out.'
              : 'Payslips go back to live figures and may change. Staff payslips for this month disappear until it is approved again.'
        }
        confirmLabel={confirm === 'approve' ? 'Approve & lock' : confirm === 'paid' ? 'Mark paid' : 'Reopen'}
        danger={confirm === 'reopen'}
        busy={busy}
        onConfirm={runAction}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
