'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, getAccessToken } from '@/lib/api';

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
    if (!getAccessToken()) {
      router.push('/super-admin/login');
      return;
    }

    api
      .get<{ data: DashboardStats }>('/super-admin/dashboard')
      .then((res) => setStats(res.data.data))
      .catch(() => router.push('/super-admin/login'))
      .finally(() => setLoading(false));
  }, [router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <p className="text-white">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="border-b border-gray-800 px-8 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">CodesApp Super Admin</h1>
          <p className="text-gray-400 text-sm">Platform overview</p>
        </div>
        <button
          onClick={() => {
            api.post('/auth/logout').finally(() => router.push('/super-admin/login'));
          }}
          className="text-gray-400 hover:text-white text-sm"
        >
          Logout
        </button>
      </header>

      <main className="p-8">
        <p className="text-gray-400 text-sm mb-6">Logged in as Super Admin</p>

        {stats && (
          <div className="grid grid-cols-3 gap-6">
            <StatCard label="Total Companies" value={stats.totalCompanies} />
            <StatCard label="Total Users" value={stats.totalUsers} />
            <StatCard label="Pending Activation" value={stats.pendingCompanies} accent />
          </div>
        )}
      </main>
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
      className={`rounded-xl p-6 ${accent ? 'bg-yellow-900/40 border border-yellow-700' : 'bg-gray-800'}`}
    >
      <p className="text-gray-400 text-sm">{label}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
    </div>
  );
}
