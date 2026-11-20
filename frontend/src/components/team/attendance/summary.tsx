'use client';

import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { fmtHours, getSummary, type MonthlySummary, type MonthlySummaryRow } from '@/lib/attendance';
import { zonedMonthString } from '@/lib/utils';
import { MonthInput, errMsg } from './shared';

function pctTone(p: number) {
  return p >= 95 ? 'success' : p >= 85 ? 'warn' : 'danger';
}

export default function SummaryTab() {
  const [month, setMonth] = useState(() => zonedMonthString());
  const [data, setData] = useState<MonthlySummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setData(null);
    setError(null);
    getSummary(month)
      .then(setData)
      .catch((e) => setError(errMsg(e, 'Could not load the summary')));
  };
  useEffect(load, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  const csv = () => {
    if (!data) return;
    const head = ['Member', 'Role', 'Work days', 'Present', 'Half days', 'Late', 'Early leaves', 'Auto-closed', 'Absent', 'Leave', 'Hours', 'Overtime', 'Attendance %'];
    const cell = (v: unknown) => {
      let s = String(v ?? '');
      if (/^[=+\-@]/.test(s)) s = `'${s}`;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.map(cell).join(',')].concat(
      data.rows.map((r) =>
        [r.name, r.role, r.scheduledDays, r.present, r.halfDay, r.late, r.earlyLeaves, r.autoClosed, r.absent, r.leave, fmtHours(r.totalMinutes), fmtHours(r.overtimeMinutes), r.attendancePct]
          .map(cell)
          .join(','),
      ),
    );
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `attendance-summary-${month}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <MonthInput id="sum-month" value={month} onChange={setMonth} />
        <span className="flex-1" />
        <Button variant="secondary" size="sm" disabled={!data?.rows.length} onClick={csv}>
          CSV
        </Button>
      </div>
      {error ? (
        <EmptyState title="Could not load the summary" description={error} action={<Button onClick={load}>Retry</Button>} />
      ) : !data ? (
        <SkeletonRows rows={6} />
      ) : (
        <DataTable<MonthlySummaryRow>
          rows={data.rows}
          rowKey={(r) => r.userId}
          emptyNode={<EmptyState icon={Users} title="No tracked members" compact />}
          columns={[
            {
              key: 'name',
              header: 'Member',
              sortValue: (r) => r.name,
              render: (r) => (
                <span className="font-medium text-ink">
                  {r.name} {r.flexible && <Badge tone="violet">Flex</Badge>}
                </span>
              ),
            },
            { key: 'days', header: 'Work days', align: 'right', sortValue: (r) => r.scheduledDays, render: (r) => r.scheduledDays },
            { key: 'present', header: 'Present', align: 'right', sortValue: (r) => r.present, render: (r) => r.present + (r.halfDay ? ` + ${r.halfDay}½` : '') },
            { key: 'late', header: 'Late', align: 'right', sortValue: (r) => r.late, render: (r) => (r.late ? <span className="text-amber-700">{r.late}</span> : '0') },
            { key: 'early', header: 'Left early', align: 'right', sortValue: (r) => r.earlyLeaves, render: (r) => r.earlyLeaves },
            { key: 'auto', header: 'Auto-closed', align: 'right', sortValue: (r) => r.autoClosed, render: (r) => (r.autoClosed ? <span className="text-violet-700">{r.autoClosed}</span> : '0') },
            { key: 'absent', header: 'Absent', align: 'right', sortValue: (r) => r.absent, render: (r) => (r.absent ? <span className="text-red-700">{r.absent}</span> : '0') },
            { key: 'leave', header: 'Leave', align: 'right', sortValue: (r) => r.leave, render: (r) => r.leave },
            { key: 'hours', header: 'Hours', align: 'right', sortValue: (r) => r.totalMinutes, render: (r) => fmtHours(r.totalMinutes) },
            { key: 'ot', header: 'Overtime', align: 'right', sortValue: (r) => r.overtimeMinutes, render: (r) => fmtHours(r.overtimeMinutes) },
            {
              key: 'pct',
              header: 'Attendance',
              align: 'right',
              sortValue: (r) => r.attendancePct,
              render: (r) => <Badge tone={pctTone(r.attendancePct)}>{r.attendancePct}%</Badge>,
            },
          ]}
        />
      )}
    </div>
  );
}
