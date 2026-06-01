'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, ArrowRight } from 'lucide-react';
import { apiFetch } from '@/lib/api';

interface PublicPlan {
  id: number;
  plan_name: string;
  tagline: string | null;
  currency: string;
  billing_period: string;
  monthly_price: number;
  setup_fee: number;
  is_highlighted: boolean;
  cta_label: string | null;
  features: string[];
}

// Render a currency code as a friendly symbol/prefix; fall back to the raw code.
function curPrefix(code: string): string {
  const c = (code || '').toUpperCase();
  if (c === 'PKR' || c === 'RS') return 'Rs';
  if (c === 'USD') return '$';
  if (c === 'EUR') return '€';
  if (c === 'GBP') return '£';
  return code ? `${code} ` : '';
}

function money(amount: number, code: string): string {
  return `${curPrefix(code)}${Number(amount).toLocaleString()}`.trim();
}

export default function PricingSection() {
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);

  useEffect(() => {
    apiFetch<PublicPlan[]>('/public/pricing')
      .then((d) => setPlans(Array.isArray(d) ? d : []))
      .catch(() => setPlans([])); // fail-graceful → section hides
  }, []);

  // Hide the whole section while loading or when no public plans exist, so the
  // landing page never shows an empty/broken pricing area.
  if (!plans || plans.length === 0) return null;

  const cols =
    plans.length >= 4
      ? 'lg:grid-cols-4'
      : plans.length === 3
        ? 'lg:grid-cols-3'
        : plans.length === 2
          ? 'sm:grid-cols-2 lg:grid-cols-2 max-w-3xl'
          : 'max-w-sm';

  return (
    <section id="pricing" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight text-gray-900">
          Simple, transparent pricing
        </h2>
        <p className="mt-3 text-gray-600">
          Pick the plan that fits your team. Upgrade anytime.
        </p>
      </div>

      <div className={`mx-auto mt-12 grid gap-6 sm:grid-cols-2 ${cols}`}>
        {plans.map((p) => (
          <div
            key={p.id}
            className={`relative flex flex-col rounded-2xl border bg-white p-6 shadow-sm transition hover:shadow-md ${
              p.is_highlighted
                ? 'border-green-500 ring-2 ring-green-500/20'
                : 'border-gray-200'
            }`}
          >
            {p.is_highlighted && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-green-500 px-3 py-1 text-xs font-semibold text-white shadow">
                Most popular
              </span>
            )}

            <h3 className="text-lg font-semibold capitalize text-gray-900">
              {p.plan_name}
            </h3>
            {p.tagline && (
              <p className="mt-1 text-sm text-gray-500">{p.tagline}</p>
            )}

            <div className="mt-5">
              <span className="text-4xl font-extrabold tracking-tight text-gray-900">
                {money(p.monthly_price, p.currency)}
              </span>
              <span className="text-gray-500"> / {p.billing_period}</span>
            </div>
            {p.setup_fee > 0 && (
              <p className="mt-1 text-xs text-gray-500">
                + {money(p.setup_fee, p.currency)} one-time setup
              </p>
            )}

            {p.features.length > 0 && (
              <ul className="mt-6 space-y-3">
                {p.features.map((f, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-sm text-gray-700">
                    <Check
                      size={18}
                      className="mt-0.5 shrink-0 text-green-600"
                    />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            )}

            <Link
              href="/register"
              className={`mt-8 inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition ${
                p.is_highlighted
                  ? 'bg-green-500 text-white hover:bg-green-600'
                  : 'border border-gray-300 text-gray-800 hover:bg-gray-50'
              }`}
            >
              {p.cta_label?.trim() || 'Get Started'}
              <ArrowRight size={16} />
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}
