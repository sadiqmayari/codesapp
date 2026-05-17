'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';

interface DashboardStats {
  totalCompanies: number;
  totalUsers: number;
  pendingCompanies: number;
}

export default function SuperAdminDashboard() {
  const router = useRouter();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<DashboardStats>('/super-admin/dashboard', {
      noOnboardingRedirect: true,
    })
      .then(setStats)
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          router.replace('/super-admin/login');
        }
      })
      .finally(() => setLoading(false));
  }, [router]);

  if (loading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div>
      <p className="text-gray-400 text-sm mb-6">Platform overview</p>
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          <StatCard label="Total Companies" value={stats.totalCompanies} />
          <StatCard label="Total Users" value={stats.totalUsers} />
          <Link href="/super-admin/clients?status=pending">
            <StatCard
              label="Pending Activation"
              value={stats.pendingCompanies}
              accent
            />
          </Link>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl p-6 ${accent ? 'bg-yellow-900/40 border border-yellow-700 hover:bg-yellow-900/60 transition' : 'bg-gray-800'}`}
    >
      <p className="text-gray-400 text-sm">{label}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
    </div>
  );
}
