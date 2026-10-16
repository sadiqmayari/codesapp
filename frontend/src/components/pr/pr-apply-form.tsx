'use client';

import { useCallback, useEffect, useState } from 'react';

interface FormInfo {
  campaignName: string;
  intro: string | null;
  companyName: string;
  logoUrl: string | null;
}

type State = 'loading' | 'ready' | 'notfound' | 'done';

/**
 * Public influencer application form. `apiPath` is the public endpoint (either
 * `/api/public/pr/<token>` or `/api/public/pr/s/<tenant>/<campaign>`). Imports
 * no authed code — safe to render on the public subdomain.
 */
export function PrApplyForm({ apiPath }: { apiPath: string }) {
  const [state, setState] = useState<State>('loading');
  const [info, setInfo] = useState<FormInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    influencerName: '',
    phone: '',
    email: '',
    city: '',
    address: '',
    instagram: '',
    tiktok: '',
    followerCount: '',
    productWishlist: '',
  });

  const base = () =>
    typeof window !== 'undefined' ? window.location.origin : '';

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base()}${apiPath}`);
      if (!res.ok) {
        setState('notfound');
        return;
      }
      const body = await res.json();
      setInfo(body?.data ?? body);
      setState('ready');
    } catch {
      setState('notfound');
    }
  }, [apiPath]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.influencerName.trim()) {
      setError('Please enter your name.');
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        influencerName: form.influencerName.trim(),
      };
      for (const k of [
        'phone',
        'email',
        'city',
        'address',
        'instagram',
        'tiktok',
        'productWishlist',
      ] as const) {
        if (form[k].trim()) payload[k] = form[k].trim();
      }
      if (form.followerCount.trim()) {
        const n = parseInt(form.followerCount.replace(/[^0-9]/g, ''), 10);
        if (Number.isFinite(n)) payload.followerCount = n;
      }
      const res = await fetch(`${base()}${apiPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setError('Something went wrong. Please try again.');
        setSubmitting(false);
        return;
      }
      setState('done');
    } catch {
      setError('Something went wrong. Please try again.');
      setSubmitting(false);
    }
  };

  if (state === 'loading') {
    return (
      <Shell>
        <p className="text-gray-400 text-center py-10">Loading…</p>
      </Shell>
    );
  }

  if (state === 'notfound') {
    return (
      <Shell>
        <div className="text-center py-10">
          <h1 className="text-lg font-semibold">Link not available</h1>
          <p className="text-gray-500 mt-1 text-sm">
            This application link is invalid or has been closed.
          </p>
        </div>
      </Shell>
    );
  }

  if (state === 'done') {
    return (
      <Shell logo={info?.logoUrl} company={info?.companyName}>
        <div className="text-center py-10">
          <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-green-100 flex items-center justify-center text-green-600 text-2xl">
            ✓
          </div>
          <h1 className="text-lg font-semibold">Thank you!</h1>
          <p className="text-gray-500 mt-1 text-sm">
            Your details have been submitted. The team will be in touch if
            selected.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell logo={info?.logoUrl} company={info?.companyName}>
      <h1 className="text-xl font-semibold">{info?.campaignName}</h1>
      {info?.intro && (
        <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{info.intro}</p>
      )}
      <form onSubmit={submit} className="mt-5 space-y-3">
        <F label="Your name *">
          <In value={form.influencerName} onChange={(v) => setForm({ ...form, influencerName: v })} />
        </F>
        <div className="grid grid-cols-2 gap-3">
          <F label="Phone (WhatsApp)">
            <In value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
          </F>
          <F label="Email">
            <In value={form.email} onChange={(v) => setForm({ ...form, email: v })} type="email" />
          </F>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <F label="Instagram handle">
            <In value={form.instagram} onChange={(v) => setForm({ ...form, instagram: v })} placeholder="@handle" />
          </F>
          <F label="TikTok handle">
            <In value={form.tiktok} onChange={(v) => setForm({ ...form, tiktok: v })} placeholder="@handle" />
          </F>
        </div>
        <F label="Total followers (approx.)">
          <In value={form.followerCount} onChange={(v) => setForm({ ...form, followerCount: v })} inputMode="numeric" />
        </F>
        <div className="grid grid-cols-2 gap-3">
          <F label="City">
            <In value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
          </F>
        </div>
        <F label="Shipping address">
          <textarea
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            rows={2}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </F>
        <F label="Products you'd love to feature (optional)">
          <textarea
            value={form.productWishlist}
            onChange={(e) => setForm({ ...form, productWishlist: e.target.value })}
            rows={2}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </F>

        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="w-full py-2.5 rounded-lg bg-pink-600 text-white font-medium hover:bg-pink-700 disabled:opacity-50"
        >
          {submitting ? 'Submitting…' : 'Submit application'}
        </button>
      </form>
    </Shell>
  );
}

function Shell({
  children,
  logo,
  company,
}: {
  children: React.ReactNode;
  logo?: string | null;
  company?: string;
}) {
  return (
    <div className="min-h-[100dvh] bg-gray-50 flex items-start sm:items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <div className="flex items-center gap-2 mb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {logo && <img src={logo} alt="" className="h-8 w-8 rounded object-contain" />}
          {company && <span className="text-sm font-medium text-gray-700">{company}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-600">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function In({
  value,
  onChange,
  type = 'text',
  placeholder,
  inputMode,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  inputMode?: 'numeric' | 'text';
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      inputMode={inputMode}
      onChange={(e) => onChange(e.target.value)}
      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
    />
  );
}
