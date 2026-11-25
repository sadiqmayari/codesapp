'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Check, Inbox, Wrench, X } from 'lucide-react';
import { useAuth } from '@/context/auth-context';
import { useToast } from '@/components/toast';
import { Modal } from '@/components/ui/modal';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import {
  LEAVE_TYPE_LABELS,
  cancelMyRequest,
  dayShort,
  fmtClock,
  getLeaveRequests,
  getMyLeave,
  requestCorrection,
  requestLeave,
  reviewLeave,
  tenantHHMM,
  type AttendanceCell,
  type LeaveRequest,
  type LeaveType,
  type MyLeave,
} from '@/lib/attendance';
import { zonedYMDString } from '@/lib/utils';
import { Field, errMsg, inputCls } from './shared';

const statusTone = { pending: 'warn', approved: 'success', rejected: 'danger' } as const;

function describe(r: LeaveRequest) {
  if (r.kind === 'correction') {
    return `Fix ${dayShort(r.fromDate)}: ${r.reqCheckIn ? `in ${r.reqCheckIn}` : ''}${r.reqCheckIn && r.reqCheckOut ? ', ' : ''}${r.reqCheckOut ? `out ${r.reqCheckOut}` : ''}`;
  }
  const range = r.fromDate === r.toDate ? dayShort(r.fromDate) : `${dayShort(r.fromDate)} – ${dayShort(r.toDate)}`;
  return `${LEAVE_TYPE_LABELS[(r.leaveType ?? 'casual') as LeaveType]} leave · ${range}${r.paid ? '' : ' · unpaid'}`;
}

export function LeaveModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const today = zonedYMDString();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [type, setType] = useState<LeaveType>('casual');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const bad = to < from;
  const submit = async () => {
    setBusy(true);
    try {
      await requestLeave({ fromDate: from, toDate: to, leaveType: type, reason: reason || undefined });
      toast.success('Leave request sent');
      setReason('');
      onDone();
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
      title="Request leave"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={bad} onClick={submit}>Send request</Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From" htmlFor="lv-from">
          <input id="lv-from" type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To" htmlFor="lv-to" hint={bad ? '"To" is before "from".' : undefined}>
          <input id="lv-to" type="date" className={inputCls} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Type" htmlFor="lv-type" hint={type === 'unpaid' ? 'Unpaid days are deducted from salary.' : undefined}>
          <select id="lv-type" className={inputCls} value={type} onChange={(e) => setType(e.target.value as LeaveType)}>
            {Object.entries(LEAVE_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Reason (optional)" htmlFor="lv-reason">
            <textarea id="lv-reason" className={`${inputCls} h-20 py-2`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

export function CorrectionModal({
  date,
  cell,
  onClose,
  onDone,
}: {
  date: string | null;
  cell: AttendanceCell | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [day, setDay] = useState('');
  const [inT, setInT] = useState('');
  const [outT, setOutT] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!date) return;
    setDay(date);
    setInT(tenantHHMM(cell?.checkInAt ?? null));
    setOutT(tenantHHMM(cell?.checkOutAt ?? null));
    setReason('');
  }, [date, cell]);
  const submit = async () => {
    setBusy(true);
    try {
      await requestCorrection({ date: day, checkIn: inT || undefined, checkOut: outT || undefined, reason: reason || undefined });
      toast.success('Sent to your admin');
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!date}
      onClose={onClose}
      title="Fix a day"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button loading={busy} disabled={!day || (!inT && !outT)} onClick={submit}>Send to admin</Button>
        </>
      }
    >
      <div className="space-y-3">
        {cell && (
          <p className="text-sm text-muted">
            Recorded: {cell.checkInAt ? fmtClock(cell.checkInAt) : 'no check-in'} – {cell.checkOutAt ? fmtClock(cell.checkOutAt) : 'no check-out'}
            {cell.checkoutSource === 'auto' || cell.checkoutSource === 'auto_activity' ? ' (closed automatically)' : ''}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Day" htmlFor="fx-day">
            <input id="fx-day" type="date" className={inputCls} value={day} max={zonedYMDString()} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <Field label="Check in" htmlFor="fx-in">
            <input id="fx-in" type="time" className={inputCls} value={inT} onChange={(e) => setInT(e.target.value)} />
          </Field>
          <Field label="Check out" htmlFor="fx-out">
            <input id="fx-out" type="time" className={inputCls} value={outT} onChange={(e) => setOutT(e.target.value)} />
          </Field>
        </div>
        <Field label="What happened?" htmlFor="fx-reason">
          <textarea id="fx-reason" className={`${inputCls} h-20 py-2`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function ReviewRow({ r, onChanged }: { r: LeaveRequest; onChanged: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null);
  const [note, setNote] = useState('');
  const own = r.userId === user?.id && user?.role !== 'owner';
  const act = async (status: 'approved' | 'rejected') => {
    setBusy(status);
    try {
      await reviewLeave(r.id, { status, reviewNote: note || undefined });
      toast.success(status === 'approved' ? 'Approved' : 'Rejected');
      onChanged();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">
          {r.userName} {r.kind === 'correction' ? <Badge tone="violet">Fix</Badge> : null}
        </p>
        <p className="text-sm text-ink">{describe(r)}</p>
        {r.reason && <p className="text-xs text-muted">“{r.reason}”</p>}
      </div>
      {r.status === 'pending' ? (
        own ? (
          <span className="text-xs text-muted">Your own request — the owner reviews it</span>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label="Note (optional)" placeholder="Note (optional)" className={`${inputCls} h-8 w-40`} value={note} onChange={(e) => setNote(e.target.value)} />
            <Button size="sm" variant="secondary" loading={busy === 'rejected'} disabled={!!busy} onClick={() => act('rejected')}>
              <X size={14} /> Reject
            </Button>
            <Button size="sm" loading={busy === 'approved'} disabled={!!busy} onClick={() => act('approved')}>
              <Check size={14} /> Approve
            </Button>
          </div>
        )
      ) : (
        <div className="flex items-center gap-2">
          <Badge tone={statusTone[r.status]}>{r.status}</Badge>
          {r.kind === 'leave' && !own && (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act(r.status === 'approved' ? 'rejected' : 'approved')}>
              {r.status === 'approved' ? 'Revoke' : 'Approve'}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

export default function RequestsTab({ isAdmin, onChanged }: { isAdmin: boolean; onChanged?: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [mine, setMine] = useState<MyLeave | null>(null);
  const [queue, setQueue] = useState<LeaveRequest[] | null>(null);
  const [filter, setFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [fixOpen, setFixOpen] = useState<string | null>(null);
  const tracked = user?.role !== 'owner';

  const load = useCallback(() => {
    if (tracked) getMyLeave().then(setMine).catch(() => setMine({ requests: [], balance: null }));
    if (isAdmin)
      getLeaveRequests(filter === 'all' ? undefined : filter)
        .then(setQueue)
        .catch((e) => {
          setQueue([]);
          toast.error(errMsg(e));
        });
    onChanged?.();
  }, [tracked, isAdmin, filter, toast, onChanged]);
  useEffect(() => {
    load();
  }, [load]);

  const cancel = async (id: number) => {
    try {
      await cancelMyRequest(id);
      load();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {isAdmin && (
        <Card className="lg:col-span-2">
          <CardHeader
            title="Team requests"
            description="Leave and day fixes waiting for you. Approving leave marks the work days; approving a fix sets the times."
            action={
              <select aria-label="Show" className={`${inputCls} w-auto`} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="all">All</option>
              </select>
            }
          />
          <CardBody>
            {!queue ? (
              <SkeletonRows rows={3} />
            ) : queue.length === 0 ? (
              <EmptyState compact icon={Inbox} title={filter === 'pending' ? 'Nothing waiting' : 'No requests'} />
            ) : (
              <ul className="divide-y divide-line">
                {queue.map((r) => (
                  <ReviewRow key={r.id} r={r} onChanged={load} />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      {tracked && (
        <Card className="lg:col-span-2">
          <CardHeader
            title="My requests"
            description={mine?.balance ? `Paid leave ${mine.balance.year}: ${mine.balance.left} of ${mine.balance.quota} days left` : undefined}
            action={
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setFixOpen(zonedYMDString())}>
                  <Wrench size={14} /> Fix a day
                </Button>
                <Button size="sm" onClick={() => setLeaveOpen(true)}>
                  <CalendarDays size={14} /> Request leave
                </Button>
              </div>
            }
          />
          <CardBody>
            {!mine ? (
              <SkeletonRows rows={2} />
            ) : mine.requests.length === 0 ? (
              <EmptyState compact icon={CalendarDays} title="No requests yet" />
            ) : (
              <ul className="divide-y divide-line">
                {mine.requests.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-ink">{describe(r)}</p>
                      {r.reviewNote && <p className="text-xs text-muted">Admin: {r.reviewNote}</p>}
                    </div>
                    <Badge tone={statusTone[r.status]}>{r.status}</Badge>
                    {r.status === 'pending' && (
                      <Button size="sm" variant="ghost" onClick={() => cancel(r.id)}>
                        Cancel
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      <LeaveModal
        open={leaveOpen}
        onClose={() => setLeaveOpen(false)}
        onDone={() => {
          setLeaveOpen(false);
          load();
        }}
      />
      <CorrectionModal
        date={fixOpen}
        cell={null}
        onClose={() => setFixOpen(null)}
        onDone={() => {
          setFixOpen(null);
          load();
        }}
      />
    </div>
  );
}
