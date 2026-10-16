'use client';

import { useCallback, useEffect, useState } from 'react';

interface FormInfo {
  campaignName: string;
  intro: string | null;
  terms: string | null;
  companyName: string;
  logoUrl: string | null;
}

type State = 'loading' | 'ready' | 'notfound' | 'done';

const VIDEO_TYPES = [
  'UGC content',
  'Faceless content',
  'Content with face',
  'Product review',
  'Unboxing',
  'Lifestyle / Vlog',
  'Health & wellness tips',
  'Educational',
  'Funny / Skits',
  'Voiceover',
  'Before & After',
  'Other',
];

const emptyForm = {
  influencerName: '',
  email: '',
  phone: '',
  instagram: '',
  tiktok: '',
  followersText: '',
  category: '',
  about: '',
  videoTypes: [] as string[],
  whyCollaborate: '',
  contentPlan: '',
  videosCount: '',
  productPreference: '',
  addrName: '',
  addrNumber: '',
  addrHouse: '',
  addrStreet: '',
  addrLandmark: '',
  addrCity: '',
  adsConsent: false,
  termsConsent: false,
};

/**
 * Public influencer application form. `apiPath` is the public endpoint. Imports
 * no authed code — safe to render on the public subdomain.
 */
export function PrApplyForm({ apiPath }: { apiPath: string }) {
  const [state, setState] = useState<State>('loading');
  const [info, setInfo] = useState<FormInfo | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ ...emptyForm });
  const set = (patch: Partial<typeof emptyForm>) => setForm((f) => ({ ...f, ...patch }));

  const base = () => (typeof window !== 'undefined' ? window.location.origin : '');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base()}${apiPath}`);
      if (!res.ok) return setState('notfound');
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

  const toggleVideoType = (t: string) =>
    set({
      videoTypes: form.videoTypes.includes(t)
        ? form.videoTypes.filter((x) => x !== t)
        : [...form.videoTypes, t],
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const required: [boolean, string][] = [
      [!!form.influencerName.trim(), 'Please enter your full name.'],
      [!!form.email.trim(), 'Please enter your email.'],
      [!!form.phone.trim(), 'Please enter your phone / WhatsApp.'],
      [!!form.instagram.trim(), 'Please paste your Instagram profile link.'],
      [!!form.followersText.trim(), 'Please enter your follower count.'],
      [!!form.category, 'Please select a category.'],
      [!!form.about.trim(), 'Please tell us about your content.'],
      [form.videoTypes.length > 0, 'Please select at least one video type.'],
      [!!form.whyCollaborate.trim(), 'Please tell us why you want to collaborate.'],
      [!!form.contentPlan.trim(), 'Please describe how you will create the videos.'],
      [!!form.videosCount, 'Please choose how many videos you can create.'],
      [!!form.addrName.trim(), 'Delivery: recipient name is required.'],
      [!!form.addrNumber.trim(), 'Delivery: phone number is required.'],
      [!!form.addrHouse.trim(), 'Delivery: house/flat/plot no. is required.'],
      [!!form.addrStreet.trim(), 'Delivery: apartment/street/neighbourhood is required.'],
      [!!form.addrCity.trim(), 'Delivery: city is required.'],
      [form.adsConsent, 'You must give lifetime ads access to continue.'],
      [form.termsConsent, 'You must accept the terms and conditions.'],
    ];
    const fail = required.find(([ok]) => !ok);
    if (fail) return setError(fail[1]);

    setSubmitting(true);
    try {
      const payload = {
        influencerName: form.influencerName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        instagram: form.instagram.trim(),
        tiktok: form.tiktok.trim() || undefined,
        followersText: form.followersText.trim(),
        category: form.category,
        about: form.about.trim(),
        videoTypes: form.videoTypes,
        whyCollaborate: form.whyCollaborate.trim(),
        contentPlan: form.contentPlan.trim(),
        videosCount: form.videosCount,
        productPreference: form.productPreference.trim() || undefined,
        address: {
          name: form.addrName.trim(),
          number: form.addrNumber.trim(),
          house: form.addrHouse.trim(),
          street: form.addrStreet.trim(),
          landmark: form.addrLandmark.trim() || undefined,
          city: form.addrCity.trim(),
        },
        adsConsent: form.adsConsent,
        termsConsent: form.termsConsent,
      };
      const res = await fetch(`${base()}${apiPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setError('Something went wrong. Please check your answers and try again.');
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
    return <Shell><p className="text-gray-400 text-center py-10">Loading…</p></Shell>;
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
            Your application has been submitted. The team will reach out if you&apos;re selected.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell logo={info?.logoUrl} company={info?.companyName} wide>
      <h1 className="text-xl font-semibold">{info?.campaignName}</h1>
      {info?.intro && (
        <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{info.intro}</p>
      )}

      <form onSubmit={submit} className="mt-5 space-y-5">
        {/* About you */}
        <Section title="About you">
          <F label="Full name *">
            <In value={form.influencerName} onChange={(v) => set({ influencerName: v })} />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Email *">
              <In type="email" value={form.email} onChange={(v) => set({ email: v })} />
            </F>
            <F label="Phone / WhatsApp *">
              <In value={form.phone} onChange={(v) => set({ phone: v })} />
            </F>
          </div>
          <F label="Instagram profile link * (paste the link, not just the handle)">
            <In value={form.instagram} onChange={(v) => set({ instagram: v })} placeholder="https://instagram.com/…" />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label="TikTok / YouTube link (optional)">
              <In value={form.tiktok} onChange={(v) => set({ tiktok: v })} />
            </F>
            <F label="Number of followers * (e.g. 25K)">
              <In value={form.followersText} onChange={(v) => set({ followersText: v })} />
            </F>
          </div>
          <F label="Category *">
            <Radios
              name="category"
              options={['Male', 'Female', 'Kids']}
              value={form.category}
              onChange={(v) => set({ category: v })}
            />
          </F>
          <F label="Who are you and what kind of content do you create? *">
            <Area value={form.about} onChange={(v) => set({ about: v })} />
          </F>
          <F label="What kind of videos do you create? * (select all that apply)">
            <div className="grid grid-cols-2 gap-1.5">
              {VIDEO_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={form.videoTypes.includes(t)}
                    onChange={() => toggleVideoType(t)}
                    className="h-4 w-4 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
                  />
                  {t}
                </label>
              ))}
            </div>
          </F>
          <F label="Why do you want to collaborate with us? *">
            <Area value={form.whyCollaborate} onChange={(v) => set({ whyCollaborate: v })} />
          </F>
          <F label="How will you create videos to promote us? * (idea or sample video link)">
            <Area value={form.contentPlan} onChange={(v) => set({ contentPlan: v })} />
          </F>
          <F label="How many videos can you create comfortably? *">
            <Radios
              name="videosCount"
              options={['2', '3']}
              labels={{ '2': '2 videos', '3': '3 videos' }}
              value={form.videosCount}
              onChange={(v) => set({ videosCount: v })}
            />
          </F>
          <F label="Product you prefer (optional)">
            <In value={form.productPreference} onChange={(v) => set({ productPreference: v })} />
          </F>
        </Section>

        {/* Delivery address */}
        <Section title="Delivery address" note="Used only if your application is approved.">
          <F label="Recipient name *">
            <In value={form.addrName} onChange={(v) => set({ addrName: v })} />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Phone number *">
              <In value={form.addrNumber} onChange={(v) => set({ addrNumber: v })} />
            </F>
            <F label="House / flat / plot no. *">
              <In value={form.addrHouse} onChange={(v) => set({ addrHouse: v })} />
            </F>
          </div>
          <F label="Apartment / street / neighbourhood *">
            <In value={form.addrStreet} onChange={(v) => set({ addrStreet: v })} />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Nearby famous place">
              <In value={form.addrLandmark} onChange={(v) => set({ addrLandmark: v })} />
            </F>
            <F label="City *">
              <In value={form.addrCity} onChange={(v) => set({ addrCity: v })} />
            </F>
          </div>
        </Section>

        {/* Consents */}
        <Section title="Agreement">
          <label className="flex items-start gap-2.5 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.adsConsent}
              onChange={(e) => set({ adsConsent: e.target.checked })}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
            />
            <span>
              I give {info?.companyName || 'the brand'} <b>lifetime access</b> to run
              ads on the content I create for this collaboration.
            </span>
          </label>
          {info?.terms && (
            <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 max-h-40 overflow-y-auto text-xs text-gray-600 whitespace-pre-wrap">
              {info.terms}
            </div>
          )}
          <label className="flex items-start gap-2.5 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.termsConsent}
              onChange={(e) => set({ termsConsent: e.target.checked })}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-pink-600 focus:ring-pink-500"
            />
            <span>I have carefully reviewed and accept all the terms and conditions.</span>
          </label>
        </Section>

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
  wide,
}: {
  children: React.ReactNode;
  logo?: string | null;
  company?: string;
  wide?: boolean;
}) {
  return (
    <div className="min-h-[100dvh] bg-gray-50 flex items-start sm:items-center justify-center p-4">
      <div
        className={`w-full ${wide ? 'max-w-xl' : 'max-w-md'} bg-white rounded-2xl shadow-sm border border-gray-100 p-6`}
      >
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

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="border-b border-gray-100 pb-1">
        <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
        {note && <p className="text-xs text-gray-400">{note}</p>}
      </div>
      {children}
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
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
    />
  );
}

function Area({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={3}
      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
    />
  );
}

function Radios({
  name,
  options,
  labels,
  value,
  onChange,
}: {
  name: string;
  options: string[];
  labels?: Record<string, string>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {options.map((o) => (
        <label key={o} className="flex items-center gap-1.5 text-sm text-gray-700">
          <input
            type="radio"
            name={name}
            checked={value === o}
            onChange={() => onChange(o)}
            className="h-4 w-4 border-gray-300 text-pink-600 focus:ring-pink-500"
          />
          {labels?.[o] ?? o}
        </label>
      ))}
    </div>
  );
}
