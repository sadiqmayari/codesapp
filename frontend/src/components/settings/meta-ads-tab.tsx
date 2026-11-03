'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { useToast } from '@/components/toast';
import { fmtDateTime } from '@/lib/utils';

interface MetaAdsConnection {
  connected: boolean;
  adAccountId: string | null;
  currency: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  usingOverrideToken: boolean;
}

export function MetaAdsTab() {
  const toast = useToast();
  const [conn, setConn] = useState<MetaAdsConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [adAccountId, setAdAccountId] = useState('');
  const [currency, setCurrency] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [token, setToken] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const c = await apiFetch<MetaAdsConnection>('/meta-ads/connection');
      setConn(c);
      setAdAccountId(c.adAccountId ?? '');
      setCurrency(c.currency ?? '');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!/^(act_)?\d{3,}$/.test(adAccountId.trim())) {
      toast.error('Enter your numeric Meta ad account id (e.g. 1234567890)');
      return;
    }
    setSaving(true);
    try {
      await apiFetch('/meta-ads/connection', {
        method: 'POST',
        body: {
          adAccountId: adAccountId.trim(),
          currency: currency.trim() || undefined,
          ...(showToken && token.trim() ? { token: token.trim() } : {}),
        },
      });
      toast.success('Meta Ads connected — pulling the last 30 days of spend');
      setToken('');
      setShowToken(false);
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Could not connect');
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setSaving(true);
    try {
      await apiFetch('/meta-ads/connection', { method: 'DELETE' });
      toast.success('Meta Ads disconnected');
      setAdAccountId('');
      setCurrency('');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const clearToken = async () => {
    setSaving(true);
    try {
      await apiFetch('/meta-ads/connection/token', { method: 'DELETE' });
      toast.success('Override token cleared — now reusing your WhatsApp token');
      load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.userMessage : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className="p-10 flex justify-center">
        <div className="w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Meta Ads</h2>
        <p className="text-sm text-gray-500 mt-1">
          Pull daily ad spend from the Meta Marketing API to power the{' '}
          <Link href="/ad-report" className="text-green-700 underline">
            Ad Report
          </Link>{' '}
          (per-product spend, sales &amp; ROAS). Spend is matched to products by
          campaign name.
        </p>
      </div>

      {conn?.connected && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          <div className="font-medium">Connected</div>
          <div className="mt-1 text-green-700">
            Ad account <code>act_{conn.adAccountId}</code>
            {conn.currency ? ` · ${conn.currency}` : ''} ·{' '}
            {conn.usingOverrideToken
              ? 'using a dedicated ads token'
              : 'reusing your WhatsApp token'}
          </div>
          <div className="mt-1 text-xs text-green-600">
            Last spend sync:{' '}
            {conn.lastSyncAt ? fmtDateTime(conn.lastSyncAt) : 'not yet'}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 leading-relaxed">
        <b>One-time Meta setup:</b> in Business Settings, reissue your System User
        token with the <code>ads_read</code> permission and assign that System
        User to this ad account. The same token then powers both WhatsApp and
        Ads — you don&apos;t need a separate one.
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Ad account ID
          </label>
          <input
            value={adAccountId}
            onChange={(e) => setAdAccountId(e.target.value)}
            placeholder="1234567890 (the numeric id, with or without act_)"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Currency <span className="text-gray-400">(optional)</span>
          </label>
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            placeholder="PKR"
            maxLength={8}
            className="w-40 border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </div>

        <div>
          {!showToken ? (
            <button
              type="button"
              onClick={() => setShowToken(true)}
              className="text-sm text-gray-600 underline"
            >
              Use a different ads token (optional)
            </button>
          ) : (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Ads access token override{' '}
                <span className="text-gray-400">
                  (blank = reuse your WhatsApp token)
                </span>
              </label>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                type="password"
                placeholder="Paste an ads_read System User token"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              {conn?.usingOverrideToken && (
                <button
                  type="button"
                  onClick={clearToken}
                  disabled={saving}
                  className="mt-2 text-xs text-red-600 underline disabled:opacity-50"
                >
                  Clear override token (reuse WhatsApp token)
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="px-5 py-2 text-sm rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : conn?.connected ? 'Update' : 'Connect'}
        </button>
        {conn?.connected && (
          <button
            onClick={disconnect}
            disabled={saving}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}
