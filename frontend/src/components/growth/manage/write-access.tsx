'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Lock, XCircle } from 'lucide-react';
import { growthManageApi, type AccessRow } from '@/lib/growth-manage';
import { Panel } from '@/components/growth/ui';

/** Connections → can CodesApp change ads on each account, and what is missing. */
export function WriteAccessPanel() {
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  useEffect(() => {
    growthManageApi.access().then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows?.length) return null;
  return (
    <Panel title="Manage ads from CodesApp" hint="Pausing, budgets, bidding and creating ads need write access on the token.">
      <ul className="divide-y divide-line">
        {rows.map((r) => (
          <li key={r.accountId} className="flex items-start gap-3 py-2.5 text-sm">
            {r.canManage ? <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" /> : r.missing.length ? <XCircle size={17} className="mt-0.5 shrink-0 text-red-600" /> : <Lock size={17} className="mt-0.5 shrink-0 text-muted" />}
            <div className="min-w-0">
              <div className="font-semibold text-ink">{r.name ?? r.accountId}</div>
              <div className="text-xs text-muted">
                {r.canManage ? 'Can pause, edit budgets and bidding, duplicate and create (paused).' : r.reason}
              </div>
              {!r.canManage && r.missing.includes('ads_management') && (
                <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-xs text-muted">
                  <li>Business Settings → System users → your system user → Generate token with <b className="text-ink">ads_management</b> (and ads_read, business_management, pages_read_engagement, pages_manage_ads).</li>
                  <li>Assign the ad account, the Facebook Page and the Instagram account to that system user with “Create ads”.</li>
                  <li>Paste the new token on the account above (Token → Replace).</li>
                </ol>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
